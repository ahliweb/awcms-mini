/**
 * Saturation-and-recovery scenario (Issue #744, epic #738
 * platform-evolution) — THE core proof for the issue's own explicit
 * requirement: "Saturation behavior matches #743 and recovery is
 * demonstrated." This does not simulate or reimplement backpressure — it
 * deliberately over-subscribes the REAL "maintenance" work-class gate
 * (`src/lib/database/work-class.ts`, Issue #743's bounded FIFO queue) via
 * `workload.ts`'s `maintenancePurgeProbe` (itself the REAL
 * `purgeExpiredAuditEvents`, Issue #447), and asserts on the REAL, already-
 * shipped outcomes: an immediate `WorkClassQueueFullError` -> `503
 * DATABASE_BUSY` + `Retry-After: 2` for callers past the bounded queue
 * cap, and a full return to baseline (`active === 0 && queued === 0`)
 * plus a successful follow-up call once the burst has drained.
 *
 * `"maintenance"` is deliberately chosen over any other work class for
 * this proof: its concurrency ceiling is 1 and its default queue-depth
 * multiplier is 4 (`getMaxQueueDepth`), so total capacity before a
 * rejection is exactly 5 — small enough to saturate deterministically with
 * a handful of concurrent calls, fast enough to stay well inside the CI
 * "safe" lane's time budget, and because every call's synchronous
 * `acquireWorkClassSlot` accept/queue/reject decision happens BEFORE any
 * I/O (`work-class.ts`'s own design), firing N calls back-to-back via
 * `Array.from` (never `await`ed between iterations, exactly like the other
 * load scenarios in this directory) deterministically reproduces "exactly
 * `N - 5` immediate rejections" — no timing race, no flake.
 */
import type {
  ScenarioContext,
  ScenarioDefinition,
  ScenarioOutcome
} from "../../resilience/scenario-runner";
import { getWorkClassSaturation } from "../../database/work-class";
import { getPerformanceSql, primaryTenantId } from "../scenario-context";
import { maintenancePurgeProbe } from "../workload";

const BURST_CALLS = 20;
// "maintenance" max concurrency (1) x (1 + default queue multiplier 4) —
// see work-class.ts's `getMaxQueueDepth` — is the deterministic capacity
// before a NEW caller is rejected immediately.
const EXPECTED_CAPACITY = 5;

export function saturationAndRecoveryScenario(): ScenarioDefinition {
  return {
    name: "saturation-and-recovery",
    tier: "safe",
    timeoutMs: 20_000,
    async run(_ctx: ScenarioContext): Promise<ScenarioOutcome> {
      const sql = getPerformanceSql();
      const tenantId = primaryTenantId();

      const results = await Promise.all(
        Array.from({ length: BURST_CALLS }, () =>
          maintenancePurgeProbe(sql, tenantId)
        )
      );

      const rejected = results.filter(
        (result) => !result.ok && result.errorCode === "DATABASE_BUSY"
      );
      const succeeded = results.filter((result) => result.ok);
      const expectedRejections = BURST_CALLS - EXPECTED_CAPACITY;

      const rejectionsLookCorrect =
        rejected.length === expectedRejections &&
        succeeded.length === EXPECTED_CAPACITY &&
        rejected.every((result) => result.status === 503) &&
        rejected.every((result) => result.retryAfterSeconds === 2);

      const saturationAfterBurst = getWorkClassSaturation().find(
        (entry) => entry.workClass === "maintenance"
      );
      const drainedToBaseline =
        saturationAfterBurst?.active === 0 &&
        saturationAfterBurst?.queued === 0;

      const recoveryProbe = await maintenancePurgeProbe(sql, tenantId);
      const recoveryDemonstrated = recoveryProbe.ok;

      const ok =
        rejectionsLookCorrect && drainedToBaseline && recoveryDemonstrated;

      return {
        ok,
        detail: ok
          ? `${BURST_CALLS} concurrent maintenance-class calls: ${rejected.length} rejected ` +
            `immediately with 503 DATABASE_BUSY + Retry-After: 2 (expected ${expectedRejections}), ` +
            `${succeeded.length} succeeded (expected ${EXPECTED_CAPACITY}), gate drained back to ` +
            `baseline, and a follow-up call after the burst succeeded (recovery demonstrated).`
          : `Saturation/recovery proof failed: rejected=${rejected.length} (expected ${expectedRejections}), ` +
            `succeeded=${succeeded.length} (expected ${EXPECTED_CAPACITY}), drainedToBaseline=${drainedToBaseline}, ` +
            `recoveryDemonstrated=${recoveryDemonstrated}.`,
        metrics: {
          burstCalls: BURST_CALLS,
          rejectedCount: rejected.length,
          succeededCount: succeeded.length,
          expectedRejections,
          expectedCapacity: EXPECTED_CAPACITY,
          activeAfterBurst: saturationAfterBurst?.active ?? -1,
          queuedAfterBurst: saturationAfterBurst?.queued ?? -1,
          recoveryProbeOk: recoveryDemonstrated ? 1 : 0
        }
      };
    }
  };
}
