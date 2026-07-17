/**
 * Bounded in-process queue that moves visitor telemetry writes OFF the
 * response path (Issue #832, epic #818).
 *
 * Before this, `src/middleware.ts` `await`ed the whole collector — tenant
 * resolution plus a `withTenant` transaction (SELECT session, UPDATE/INSERT
 * session, INSERT visit_event) — before returning the response, adding 4-6
 * round trips to TTFB on **every public request**. The collector was
 * already fail-open (a failed write never breaks a request), which is
 * exactly what makes deferring it safe: nothing about the response depends
 * on the write's outcome.
 *
 * **Why a queue instead of the issue's "minimal: `void collect(...)`".**
 * A bare `void` would have silently broken visitor tracking. The collector
 * also calls `context.cookies.set(...)` for the visitor key, and Astro
 * serializes `context.cookies` into the response the moment middleware
 * returns — a fire-and-forget cookie write would land after that and be
 * dropped, so every request would mint a fresh visitor key and every
 * pageview would open a brand-new "session". The split that makes deferral
 * correct is therefore by *dependency*, not by convenience: everything that
 * touches `context` (config, cookie plan/set, header-derived IP/geo/UA)
 * stays synchronous and inline in the middleware — it is pure, needs no
 * database, and costs microseconds — while only the tenant lookup and the
 * write itself are handed to this queue as a self-contained task closing
 * over plain values.
 *
 * **Backpressure.** The queue is bounded (`MAX_QUEUE_DEPTH`). Telemetry is
 * the lowest-value work in the process (its `withTenant` call already uses
 * `workClass: "background_sync"`), so when the queue is full the *new* task
 * is dropped and counted, rather than growing memory without bound or
 * evicting older events that are already closer to being written. A drop is
 * logged at `warning` and counted on `visitor_analytics_queue_dropped_total`
 * — this is the one place where telemetry loss is possible, and it is loud
 * by construction rather than silent.
 *
 * **Shutdown (no loss on normal termination).** `@astrojs/node`'s
 * standalone server installs no signal handlers, so an un-flushed queue
 * would lose every pending event on SIGTERM. `flushVisitorTelemetryQueue()`
 * drains pending + in-flight work, and is wired to SIGTERM/SIGINT/
 * `beforeExit` on first use (see `ensureShutdownHook`).
 */
import { log } from "../../../lib/logging/logger";
import {
  recordCounter,
  recordGauge
} from "../../../lib/observability/metrics-port";

/**
 * A queued unit of work. Must be fully self-contained — it closes over
 * plain values only, never an Astro `APIContext`/`Request`/`Response`,
 * which are request-scoped and may be torn down by the time this runs.
 */
export type VisitorTelemetryTask = () => Promise<void>;

/**
 * Bounded so a traffic burst (or a stalled database) cannot turn deferred
 * telemetry into unbounded memory growth. At ~1KB of retained closure per
 * task this caps the queue's footprint in the low megabytes, while still
 * absorbing a multi-second database stall at ordinary traffic.
 */
export const MAX_QUEUE_DEPTH = 1_000;

/**
 * How many telemetry writes may be in flight at once. Kept small on
 * purpose: these writes run as `background_sync`, the lowest-priority DB
 * work class (doc 16), and must never crowd real interactive work out of
 * the connection pool — the exact contention Issue #824 measured. Draining
 * slower than traffic arrives is handled by the bounded queue above, not by
 * widening this.
 */
export const MAX_CONCURRENT_DRAINS = 2;

/** How long `flushVisitorTelemetryQueue()` waits during shutdown before giving up. */
export const FLUSH_TIMEOUT_MS = 2_000;

const queue: VisitorTelemetryTask[] = [];
const inFlight = new Set<Promise<void>>();
let waiters: Array<() => void> = [];
let shutdownHookInstalled = false;
let draining = false;

function notifyIdleWaiters(): void {
  if (queue.length > 0 || inFlight.size > 0) {
    return;
  }

  const pending = waiters;
  waiters = [];

  for (const resolve of pending) {
    resolve();
  }
}

/**
 * Runs one task with a belt-and-braces `catch`. `collectVisitorTelemetry`
 * already contains every failure internally, but this queue's tasks are no
 * longer awaited by anyone: an unhandled rejection escaping here would be
 * an unhandled promise rejection, which can terminate the process outright
 * — turning "analytics is fail-open" into "analytics can kill the server".
 * Fail-open only counts if nothing can escape.
 */
async function runTask(task: VisitorTelemetryTask): Promise<void> {
  try {
    await task();
  } catch (error) {
    log("warning", "visitor_analytics.queue.task_failed", {
      moduleKey: "visitor_analytics",
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
}

function drain(): void {
  if (draining) {
    return;
  }

  draining = true;

  try {
    while (queue.length > 0 && inFlight.size < MAX_CONCURRENT_DRAINS) {
      const task = queue.shift();

      if (!task) {
        break;
      }

      const promise = runTask(task).finally(() => {
        inFlight.delete(promise);
        // More work may have arrived (or a slot just freed up) while this
        // task was running.
        drain();
        notifyIdleWaiters();
      });

      inFlight.add(promise);
    }
  } finally {
    draining = false;
  }

  notifyIdleWaiters();
}

/**
 * Installs the shutdown flush lazily — on first enqueue, never at import
 * time. Registering process-wide signal handlers as an import side effect
 * would leak into every test runner and CLI script that transitively
 * imports this module, and would change those processes' termination
 * behavior for no reason.
 *
 * Signal handling detail that matters: installing ANY SIGTERM/SIGINT
 * listener suppresses the default "terminate now" behavior, so this must
 * take responsibility for finishing the job. `process.once` means the
 * listener removes itself before we re-raise the same signal, which then
 * hits the default handler and terminates with the correct
 * signal-derived exit code — rather than `process.exit(0)`, which would
 * report a clean exit for what was actually a signal, and would skip any
 * other cleanup an operator or future adapter has registered.
 */
function ensureShutdownHook(): void {
  if (shutdownHookInstalled) {
    return;
  }

  shutdownHookInstalled = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void flushVisitorTelemetryQueue().finally(() => {
        process.kill(process.pid, signal);
      });
    });
  }

  // Fires when the event loop empties without an explicit exit — covers a
  // normal, signal-less shutdown. Unlike the signal handlers, this one must
  // NOT re-raise anything; returning is enough to let the process exit.
  process.on("beforeExit", () => {
    void flushVisitorTelemetryQueue();
  });
}

/**
 * Hands a telemetry write to the background queue. Synchronous, never
 * throws, and never returns a promise the caller could accidentally
 * `await` back onto the response path — the whole point is that the
 * response does not wait for this.
 */
export function enqueueVisitorTelemetry(task: VisitorTelemetryTask): void {
  ensureShutdownHook();

  if (queue.length >= MAX_QUEUE_DEPTH) {
    recordCounter("visitor_analytics_queue_dropped_total");
    log("warning", "visitor_analytics.queue.overflow", {
      moduleKey: "visitor_analytics",
      queueDepth: queue.length
    });

    return;
  }

  queue.push(task);
  recordGauge("visitor_analytics_queue_depth", queue.length);
  drain();
}

/**
 * Resolves once the queue is empty and no task is in flight. Bounded by
 * `timeoutMs` so a hung database can never hold shutdown open forever — on
 * timeout the remaining events ARE lost, which is why the timeout is logged
 * loudly rather than swallowed.
 */
export async function flushVisitorTelemetryQueue(
  timeoutMs: number = FLUSH_TIMEOUT_MS
): Promise<void> {
  drain();

  if (queue.length === 0 && inFlight.size === 0) {
    return;
  }

  const idle = new Promise<void>((resolve) => {
    waiters.push(resolve);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const outcome = await Promise.race([
      idle.then(() => "idle" as const),
      timedOut
    ]);

    if (outcome === "timeout") {
      log("warning", "visitor_analytics.queue.flush_timeout", {
        moduleKey: "visitor_analytics",
        queueDepth: queue.length,
        inFlight: inFlight.size,
        timeoutMs
      });
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Test-only introspection — never branch production behavior on this. */
export function getVisitorTelemetryQueueStats(): {
  queued: number;
  inFlight: number;
} {
  return { queued: queue.length, inFlight: inFlight.size };
}

/**
 * Test-only: drops PENDING work so one test's queue cannot leak into the
 * next.
 *
 * Deliberate limitation: it cannot cancel work already IN FLIGHT — a task
 * mid-`await` keeps running and keeps occupying a drain slot. A test that
 * enqueues a long-running task therefore still leaks it into the next test
 * unless it also awaits `flushVisitorTelemetryQueue()`. (Not hypothetical:
 * this is precisely how a 5-second task in one test made an unrelated test
 * that followed it time out while writing this module's own suite.)
 */
export function resetVisitorTelemetryQueue(): void {
  queue.length = 0;
  waiters = [];
}
