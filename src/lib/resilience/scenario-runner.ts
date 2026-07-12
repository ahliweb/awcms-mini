/**
 * Generic failure-injection scenario harness (Issue #699, epic #679
 * platform-hardening). Every DR/resilience scenario (`./scenarios/*.ts`)
 * implements the same small `ScenarioDefinition` shape — a name, a tier
 * (`"safe"` runs in CI on every change; `"full"` is heavier/slower and
 * only runs on demand/schedule, see `docs/awcms-mini/
 * resilience-dr-verification.md`), a deterministic timeout, and a `run`
 * function that does its own setup/execute/verify/cleanup internally
 * (each scenario's own file documents those four phases explicitly) and
 * returns a plain pass/fail/skip outcome — `runScenario` below is the one
 * place that turns that into a uniformly-timed, uniformly-shaped
 * `ScenarioResult`, and `computeDrOverall` is the one place the whole
 * run's tri-state verdict is computed.
 *
 * Tri-state overall verdict deliberately mirrors
 * `deploy/backup/restore-drill.sh`'s own `overall` field (Issue #691, PR
 * #708 review): "pass" requires EVERY scenario to have genuinely run and
 * passed — a "skipped" scenario (e.g. `backup-restore-drill` when no
 * version-matched `pg_dump`/`pg_restore` is available) must never be
 * silently treated as "it passed", so "incomplete" is a third, distinct
 * state a report reader can't mistake for either "pass" or "fail".
 */

export type ScenarioTier = "safe" | "full";
export type ScenarioStatus = "pass" | "fail" | "skipped";

export type ScenarioContext = {
  /** Guaranteed non-empty by the time scenarios run — `authorizeDrDrill` (`./target-guard.ts`) already validated it before any scenario executes. */
  databaseUrl: string;
  env: NodeJS.ProcessEnv;
};

export type ScenarioOutcome = {
  /** Ignored when `skipped` is `true`. */
  ok: boolean;
  /** A scenario reports `skipped: true` for a genuine environment constraint (e.g. missing compatible `pg_dump`) — never for "this scenario chose not to prove anything", which must always be `ok: false` instead. */
  skipped?: boolean;
  detail: string;
  /** Free-form named metrics (RTO/RPO proxies, latencies, counts) — printed as-is in the JSON report. */
  metrics?: Record<string, number | string>;
};

export type ScenarioDefinition = {
  name: string;
  tier: ScenarioTier;
  timeoutMs: number;
  run: (ctx: ScenarioContext) => Promise<ScenarioOutcome>;
};

export type ScenarioResult = {
  name: string;
  tier: ScenarioTier;
  status: ScenarioStatus;
  detail: string;
  durationMs: number;
  metrics: Record<string, number | string>;
};

/**
 * Runs one scenario under an outer timeout (deterministic upper bound,
 * regardless of whether the scenario's own internals cooperate with
 * cancellation — same documented limit `src/lib/jobs/job-runner.ts`'s
 * `AbortSignal` cancellation model already accepts) and never throws: a
 * scenario that throws (bug, unexpected error, or the outer timeout
 * winning the race) becomes a `"fail"` result with the error's message as
 * `detail`, so a caller always gets a result to aggregate/report on.
 */
export async function runScenario(
  definition: ScenarioDefinition,
  ctx: ScenarioContext
): Promise<ScenarioResult> {
  const start = performance.now();

  try {
    const outcome = await withTimeout(
      definition.run(ctx),
      definition.timeoutMs,
      definition.name
    );

    return {
      name: definition.name,
      tier: definition.tier,
      status: outcome.skipped ? "skipped" : outcome.ok ? "pass" : "fail",
      detail: outcome.detail,
      durationMs: performance.now() - start,
      metrics: outcome.metrics ?? {}
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      name: definition.name,
      tier: definition.tier,
      status: "fail",
      detail: message,
      durationMs: performance.now() - start,
      metrics: {}
    };
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  scenarioName: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Scenario "${scenarioName}" exceeded its ${timeoutMs}ms timeout.`
        )
      );
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export type DrOverall = "pass" | "incomplete" | "fail";

/**
 * Pure aggregation — no I/O — so this exact tri-state rule is directly
 * unit-testable. "fail" wins outright if ANY scenario failed; "pass"
 * requires EVERY scenario to have genuinely passed; anything else (one or
 * more "skipped", none "fail") is "incomplete".
 */
export function computeDrOverall(results: ScenarioResult[]): DrOverall {
  if (results.some((result) => result.status === "fail")) {
    return "fail";
  }

  if (results.every((result) => result.status === "pass")) {
    return "pass";
  }

  return "incomplete";
}
