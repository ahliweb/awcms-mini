/**
 * "background_sync" workload scenario (Issue #744, epic #738
 * platform-evolution) — the issue's "sync/event/job workloads" model. A
 * burst of concurrent `backgroundSyncClaim` calls (`workload.ts`), the same
 * `FOR UPDATE SKIP LOCKED` claim shape `object-dispatch.ts` uses in
 * production, spread across every seeded tenant. `SKIP LOCKED` means
 * concurrent claimers never block each other on the same row — this
 * scenario's own success condition is "every call completes without error"
 * (a regression that reintroduced blocking/contention would show up as
 * elevated p95 here, not a hard failure), since the number of rows
 * actually claimed depends on how many `status = 'pending'` rows remain at
 * scenario run time (this scenario mutates queue rows to `'sending'` —
 * expected and safe; it never touches `awcms_mini_audit_events`, so it
 * cannot affect the query-plan gate's row-count assumptions for that
 * table).
 */
import type {
  ScenarioContext,
  ScenarioDefinition,
  ScenarioOutcome
} from "../../resilience/scenario-runner";
import {
  flattenWorkloadMetrics,
  summarizeWorkload,
  type CallSample
} from "../metrics-aggregate";
import { allTenantIds, getPerformanceSql } from "../scenario-context";
import { backgroundSyncClaim } from "../workload";

// Below "background_sync"'s own total capacity (max concurrency 4 x
// (1 + default queue multiplier 4) = 20, see work-class.ts) — with
// headroom, same reasoning as interactive-load.ts's own constant.
const CONCURRENT_CALLS = 16;
const MAX_ERROR_RATE_PERCENT = 5;

export function backgroundSyncClaimLoadScenario(): ScenarioDefinition {
  return {
    name: "background-sync-claim-load",
    tier: "safe",
    timeoutMs: 20_000,
    async run(_ctx: ScenarioContext): Promise<ScenarioOutcome> {
      const sql = getPerformanceSql();
      const tenantIds = allTenantIds();
      const startedAt = performance.now();

      const samples: CallSample[] = await Promise.all(
        Array.from({ length: CONCURRENT_CALLS }, async (_unused, index) => {
          const tenantId = tenantIds[index % tenantIds.length]!;
          const callStart = performance.now();
          const result = await backgroundSyncClaim(sql, tenantId);

          return { latencyMs: performance.now() - callStart, ok: result.ok };
        })
      );

      const wallClockDurationMs = performance.now() - startedAt;
      const metrics = summarizeWorkload(samples, wallClockDurationMs);
      const ok = metrics.throughput.errorRatePercent <= MAX_ERROR_RATE_PERCENT;

      return {
        ok,
        detail: ok
          ? `${CONCURRENT_CALLS} concurrent outbox-claim calls (FOR UPDATE SKIP LOCKED): ` +
            `error rate=${metrics.throughput.errorRatePercent.toFixed(1)}%.`
          : `background_sync claim load exceeded error-rate budget: ${metrics.throughput.errorRatePercent.toFixed(1)}% ` +
            `(max ${MAX_ERROR_RATE_PERCENT}%).`,
        metrics: flattenWorkloadMetrics(metrics)
      };
    }
  };
}
