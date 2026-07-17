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
 *
 * **Stage 1 of two (Issue #846).** This queue no longer writes. Its tasks
 * resolve the tenant (usually a cache hit, zero round trips) and hand a
 * plain record to `visit-event-batcher.ts`, which groups records per tenant
 * so that N concurrent visits cost ONE transaction instead of N. The write
 * itself was 5.2 round trips per event, ~58% of it per-event transaction
 * scaffolding; see `collector.ts`'s header for the measured decomposition.
 * `flushVisitorTelemetryQueue()` drains BOTH stages, so the no-loss-on-
 * SIGTERM guarantee above still holds end to end.
 */
import { log } from "../../../lib/logging/logger";
import {
  recordCounter,
  recordGauge
} from "../../../lib/observability/metrics-port";
import {
  flushVisitEventBatches,
  getVisitEventBatcherStats
} from "./visit-event-batcher";

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
 * Installs the shutdown flush. **Must be called by the application entry
 * point that actually serves requests** (`src/middleware.ts`'s `onRequest`)
 * — never automatically from `enqueueVisitorTelemetry`, and never at import
 * time. Idempotent, so calling it per request costs one boolean check.
 *
 * **Why this is explicit rather than automatic (regression, found by the
 * epic #818 wave-2 integration run — the fix must not be undone).** The
 * first version of this module installed these handlers lazily on first
 * `enqueue`. That made a *data-plane* call silently rewrite the whole
 * PROCESS's termination semantics, which is not a library's decision to
 * make: any process that ever queued one telemetry event — a test runner, a
 * CLI script, a job worker — inherited a SIGTERM handler it never asked
 * for.
 *
 * The concrete failure: `tests/unit/job-runner.test.ts` legitimately does
 * `process.emit("SIGTERM")` to exercise `runJob`'s own cancellation path. A
 * handler here CANNOT distinguish that synthetic, in-process `emit()` from
 * a real OS signal — so it flushed and then re-raised a REAL SIGTERM at the
 * process (below), killing the entire `bun test` runner ~1s in, with no
 * results printed. Running either file alone passed; only the pair failed,
 * and it read as "the suite hangs" rather than "the suite kills itself".
 *
 * Gating installation on the HTTP entry point fixes it at the root: a real
 * server process is the only place that both needs the flush AND owns
 * process lifecycle. `bun test` never evaluates `src/middleware.ts` (it
 * imports the `astro:middleware` virtual module, which only Astro's own
 * pipeline provides), so no test process can ever acquire these handlers,
 * by construction rather than by convention.
 *
 * Signal handling detail that matters: installing ANY SIGTERM/SIGINT
 * listener suppresses the default "terminate now" behavior, so whoever
 * installs one MUST take responsibility for finishing the job — there is no
 * "flush but leave termination alone" option. `process.once` means the
 * listener removes itself before we re-raise the same signal, which then
 * hits the default handler and terminates with the correct signal-derived
 * exit code — rather than `process.exit(0)`, which would report a clean
 * exit for what was actually a signal, and would skip any other cleanup an
 * operator or future adapter has registered.
 */
export function installVisitorTelemetryShutdownHook(): void {
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
  // Deliberately does NOT install the shutdown hook — see
  // `installVisitorTelemetryShutdownHook`'s docblock. A data-plane call must
  // never rewrite the process's termination semantics as a side effect.
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
 * Resolves once the TASK stage is empty and no task is in flight. Bounded
 * by `timeoutMs`. Callers want `flushVisitorTelemetryQueue`, which also
 * flushes the batcher this stage feeds.
 */
async function drainTaskStage(timeoutMs: number): Promise<void> {
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

/**
 * Drains BOTH stages: the task queue above, and the per-tenant batches its
 * tasks buffer (`visit-event-batcher.ts`, Issue #846). Bounded by
 * `timeoutMs` overall so a hung database can never hold shutdown open
 * forever — on timeout the remaining events ARE lost, which is why both
 * stages log the timeout loudly rather than swallowing it.
 *
 * Two passes, not one: a stage-1 task's whole job is now to BUFFER a record
 * into stage 2, so flushing stage 2 before stage 1 is idle would leave the
 * tail behind — exactly the silent shutdown loss Issue #846 warned against.
 * Stage 2 never creates stage-1 work, so the passes converge; a second pass
 * only runs if work actually remains and the budget allows it.
 *
 * Batching does NOT weaken this: `flushVisitEventBatches` writes PARTIAL
 * batches on demand, never waiting for `MAX_BATCH_SIZE` or a linger timer.
 */
export async function flushVisitorTelemetryQueue(
  timeoutMs: number = FLUSH_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  for (let pass = 0; pass < 2; pass += 1) {
    await drainTaskStage(remaining());
    await flushVisitEventBatches(remaining());

    const taskStageIdle = queue.length === 0 && inFlight.size === 0;
    const batcherIdle = getVisitEventBatcherStats().pending === 0;

    if (taskStageIdle && batcherIdle) {
      return;
    }

    if (remaining() === 0) {
      return;
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
