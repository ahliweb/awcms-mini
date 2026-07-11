/**
 * Shared worker runner (Issue #697, epic #679, platform-hardening).
 *
 * Every `scripts/*.ts` cron/systemd worker (`bun run logs:audit:purge`,
 * `bun run modules:sync`, ...) re-implements the same handful of concerns
 * slightly differently: iterate tenants, generate a correlation/run id,
 * decide the process exit code, print a completion summary, and log
 * failures safely. `runJob` is the single place that logic now lives —
 * migrating a script to it is OPTIONAL and incremental (see
 * `docs/awcms-mini/deployment-profiles.md` §Shared worker runner); scripts
 * that have not migrated yet remain fully valid.
 *
 * What this module deliberately does NOT do: it is not a job *queue* — it
 * has no persistence, no scheduling, no cross-process work distribution,
 * and no automatic retry-with-backoff loop. Scheduling stays exactly what
 * it already is (an external cron/systemd timer/container scheduler
 * invoking `bun run <script>`); this only makes a single invocation of a
 * single script safer and more observable. Introducing an orchestration
 * platform (BullMQ, Temporal, ...) is explicitly out of scope (issue text:
 * "tanpa memperkenalkan orchestration platform terpisah").
 *
 * Composition, not a god-object: `runJob` composes three independent
 * modules a caller can also use directly —
 * `./advisory-lock.ts` (duplicate-run prevention),
 * `./batching.ts` (bounded tenant/item iteration), and
 * `./retry-classification.ts` (safe-to-retry-next-tick classification) —
 * plus `../logging/error-sanitizer.ts` (Issue #687) for redaction. No new
 * redaction/log-masking mechanism is added here.
 */
import { acquireAdvisoryLock } from "./advisory-lock";
import {
  classifyError,
  type RetryClassification
} from "./retry-classification";
import {
  sanitizeErrorForLog,
  type SafeErrorDetail
} from "../logging/error-sanitizer";

export type JobStatus =
  "success" | "partial" | "failed" | "skipped" | "timeout" | "terminated";

/** What a job handler returns on successful completion (including a "partial" outcome — some items failed, but the run itself did not throw). Every field is optional: a handler that returns nothing (`void`) is treated as a plain success with no counts. */
export type JobHandlerResult = {
  /** Defaults to `"success"`. Set `"partial"` when the handler completed but some individual items failed (surfaced in telemetry, and `applyJobExitCode` treats it as non-zero). */
  status?: "success" | "partial";
  /** Free-form named counters (e.g. `{ tenantsChecked: 5, purged: 120 }`) — printed as-is in JSON telemetry. */
  itemCounts?: Record<string, number>;
  /** Short human-readable summary, mirrors the `detail` field `production-preflight.ts`'s `StageResult` already uses. */
  detail?: string;
};

export type JobContext = {
  runId: string;
  correlationId: string;
  dryRun: boolean;
  /** Aborts when the job's timeout elapses OR the process receives SIGTERM/SIGINT. Well-behaved handlers should check `signal.aborted` in loops (or pass it to abortable I/O) so cancellation is prompt — see the module doc comment on `runJob` for the limits of what an `AbortSignal` can and cannot interrupt. */
  signal: AbortSignal;
};

export type JobDefinition = {
  /** Used as the advisory-lock key (via `hashJobNameToInt32`) and the label in telemetry — should be stable across releases (e.g. the same string as the `bun run <name>` package.json script), since changing it changes the lock key. */
  name: string;
  description: string;
  /** Defaults to `DEFAULT_JOB_TIMEOUT_MS` (15 minutes). */
  timeoutMs?: number;
  handler: (ctx: JobContext) => Promise<JobHandlerResult | void>;
};

export type JobResult = {
  jobName: string;
  runId: string;
  correlationId: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  itemCounts?: Record<string, number>;
  detail?: string;
  error?: SafeErrorDetail;
  retryClassification?: RetryClassification;
};

export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;

export type RunJobOptions = {
  /** Pool used to reserve the advisory-lock connection (`sql.reserve()`) — typically `getWorkerDatabaseClient()`. The handler receives its OWN `sql`/tenant-scoped clients via closure, not through this option; this `sql` is used for locking only. */
  sql: Bun.SQL;
  correlationId?: string;
  dryRun?: boolean;
  /** Signals that trigger graceful cancellation + lock release. Defaults to `["SIGTERM", "SIGINT"]`. */
  terminationSignals?: NodeJS.Signals[];
};

function nowIso(date: Date): string {
  return date.toISOString();
}

function buildResult(
  definition: JobDefinition,
  runId: string,
  correlationId: string,
  dryRun: boolean,
  startedAt: Date,
  status: JobStatus,
  extra: Partial<
    Pick<JobResult, "itemCounts" | "detail" | "error" | "retryClassification">
  > = {}
): JobResult {
  const finishedAt = new Date();

  return {
    jobName: definition.name,
    runId,
    correlationId,
    status,
    startedAt: nowIso(startedAt),
    finishedAt: nowIso(finishedAt),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    dryRun,
    ...extra
  };
}

/**
 * Runs `definition.handler` under a per-job-name advisory lock, a timeout,
 * and SIGTERM/SIGINT-aware cancellation, returning structured, already-
 * redacted telemetry (`JobResult`) rather than throwing — `runJob` itself
 * never rejects (a thrown handler error becomes `status: "failed"` with a
 * sanitized `error`), so callers always get a result to log/exit on.
 *
 * Lock release is guaranteed on every path (success, thrown error, timeout,
 * termination signal) by a single `finally` block calling
 * `lockHandle.release()` — see `./advisory-lock.ts` for why this is safe
 * even if the handler itself is still running in the background after a
 * timeout/termination (the lock's reserved connection is independent of
 * whatever connection(s) the handler uses).
 *
 * Cancellation model: `timeoutMs` and the termination signals both call the
 * same `AbortController.abort()` — this only *signals* the handler via
 * `ctx.signal`; it cannot forcibly interrupt a handler that never checks
 * the signal or awaits anything (standard `AbortSignal` cooperative-
 * cancellation limits, not something this runner can work around without a
 * separate OS process per job, which would turn this into the orchestration
 * platform the issue explicitly says not to build). What IS guaranteed
 * regardless of handler cooperation is: (a) `runJob` returns promptly with
 * `status: "timeout"`/`"terminated"` instead of hanging forever, and (b) the
 * advisory lock is released promptly, so the NEXT run is never blocked by a
 * stuck previous one.
 */
export async function runJob(
  definition: JobDefinition,
  options: RunJobOptions
): Promise<JobResult> {
  const runId = crypto.randomUUID();
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const dryRun = options.dryRun ?? false;
  const timeoutMs = definition.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const startedAt = new Date();

  let lockHandle;

  try {
    lockHandle = await acquireAdvisoryLock(options.sql, definition.name);
  } catch (error) {
    return buildResult(
      definition,
      runId,
      correlationId,
      dryRun,
      startedAt,
      "failed",
      {
        error: sanitizeErrorForLog(error),
        retryClassification: classifyError(error),
        detail: "Failed to acquire the job's advisory lock."
      }
    );
  }

  if (!lockHandle) {
    return buildResult(
      definition,
      runId,
      correlationId,
      dryRun,
      startedAt,
      "skipped",
      {
        detail:
          "Another instance of this job already holds the advisory lock; skipped."
      }
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  let terminatedBy: NodeJS.Signals | null = null;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Never let this timer alone keep the process alive.
  timer.unref?.();

  const signalNames = options.terminationSignals ?? ["SIGTERM", "SIGINT"];
  const registeredSignalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  for (const signalName of signalNames) {
    const handler = () => {
      terminatedBy = signalName;
      controller.abort();
    };
    process.once(signalName, handler);
    registeredSignalHandlers.push([signalName, handler]);
  }

  try {
    const abortedPromise = new Promise<"aborted">((resolve) => {
      if (controller.signal.aborted) {
        resolve("aborted");
        return;
      }
      controller.signal.addEventListener("abort", () => resolve("aborted"), {
        once: true
      });
    });

    const handlerPromise = Promise.resolve().then(() =>
      definition.handler({
        runId,
        correlationId,
        dryRun,
        signal: controller.signal
      })
    );
    const settledPromise = handlerPromise.then(
      (value): { kind: "settled"; value: JobHandlerResult | void } => ({
        kind: "settled",
        value
      })
    );

    const race = await Promise.race([settledPromise, abortedPromise]);

    if (race === "aborted") {
      const status: JobStatus = terminatedBy ? "terminated" : "timeout";

      return buildResult(
        definition,
        runId,
        correlationId,
        dryRun,
        startedAt,
        status,
        {
          detail: terminatedBy
            ? `Job terminated by ${terminatedBy}.`
            : `Job exceeded its ${timeoutMs}ms timeout.`
        }
      );
    }

    const handlerResult = race.value ?? {};

    return buildResult(
      definition,
      runId,
      correlationId,
      dryRun,
      startedAt,
      handlerResult.status ?? "success",
      {
        itemCounts: handlerResult.itemCounts,
        detail: handlerResult.detail
      }
    );
  } catch (error) {
    return buildResult(
      definition,
      runId,
      correlationId,
      dryRun,
      startedAt,
      "failed",
      {
        error: sanitizeErrorForLog(error),
        retryClassification: classifyError(error)
      }
    );
  } finally {
    clearTimeout(timer);
    for (const [signalName, handler] of registeredSignalHandlers) {
      process.off(signalName, handler);
    }
    await lockHandle.release();
  }
}

/** `true` for `"success"`/`"skipped"` — mirrors the exit-code contract every migrated script's `main()` applies via `process.exitCode`. */
export function isJobResultOk(result: JobResult): boolean {
  return result.status === "success" || result.status === "skipped";
}

/**
 * Sets `process.exitCode` per the exit-code contract (0 success/skipped,
 * non-zero for fail/partial/timeout/terminated) — same shape
 * `logScriptFailure` (`src/lib/logging/error-log.ts`, Issue #687) already
 * uses for the failure half; this covers the additional statuses `runJob`
 * introduces.
 */
export function applyJobExitCode(result: JobResult): void {
  if (!isJobResultOk(result)) {
    process.exitCode = 1;
  }
}

/** JSON telemetry to stdout — always, regardless of `--json-output`. */
export function printJobTelemetry(result: JobResult): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * A single human-readable operator-facing summary line for `console.log`/
 * `console.error` after `runJob` returns — mirrors the exact shape
 * `logScriptFailure` (`src/lib/logging/error-log.ts`, Issue #687) already
 * prints for failures (`"<label> — <redacted message>"`), WITHOUT
 * re-deriving redaction: `result.error`/`result.detail` here are already
 * sanitized by `runJob` itself (via `sanitizeErrorForLog`), so this only
 * formats already-safe strings, it never touches the original raw error.
 */
export function formatJobOutcomeLine(result: JobResult): string {
  const base = `${result.jobName} (${result.status}, ${result.durationMs}ms)`;

  if (result.error) {
    return `${base} — ${result.error.message}`;
  }
  if (result.detail) {
    return `${base} — ${result.detail}`;
  }
  return base;
}

/** Optional structured output to a file, same `--json-output=<path>` pattern as `scripts/production-preflight.ts` (Issue #684). No-op if `jsonOutputPath` is `null`. */
export async function writeJobTelemetry(
  result: JobResult,
  jsonOutputPath: string | null
): Promise<void> {
  if (!jsonOutputPath) {
    return;
  }
  await Bun.write(jsonOutputPath, JSON.stringify(result, null, 2));
}

export type JobCliOptions = {
  dryRun: boolean;
  jsonOutputPath: string | null;
};

/** Parses the two generic flags every migrated script's CLI accepts — `--dry-run` and `--json-output=<path>` (same flag name/shape as `production-preflight.ts`'s own `parseArgs`). Script-specific flags (e.g. `--retention-days=`) are parsed separately by each script, same as before. */
export function parseJobCliArgs(argv: string[]): JobCliOptions {
  const jsonOutputFlag = argv.find((arg) => arg.startsWith("--json-output="));

  return {
    dryRun: argv.includes("--dry-run"),
    jsonOutputPath: jsonOutputFlag ? jsonOutputFlag.split("=", 2)[1]! : null
  };
}
