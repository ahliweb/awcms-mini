/**
 * "interactive" workload scenario (Issue #744, epic #738
 * platform-evolution) — a burst of concurrent real RLS-scoped audit-event
 * reads (`workload.ts`'s `interactiveAuditRead`) spread across every
 * seeded tenant (including the noisy-neighbor tenant), capturing
 * p50/p95/p99 latency, throughput, and error rate — the issue's
 * "interactive API reads/writes" workload model and its own required
 * metric list.
 *
 * Budget: generous on purpose (mirrors
 * `tests/unit/observability-metrics-performance.test.ts`'s own "smoke
 * test, not a strict micro-benchmark" philosophy) — this scenario exists
 * to prove the workload runs correctly end to end and produces real
 * numbers, not to enforce a tight SLA that would flake on a loaded CI
 * runner. Tight, versioned regression budgets belong to the query-plan
 * gate (`query-plan-budgets.ts`), which compares plan SHAPE (index vs.
 * seq scan), not absolute wall-clock time.
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
import { interactiveAuditRead } from "../workload";

// Below "interactive"'s own total capacity (max concurrency 8 x (1 +
// default queue multiplier 4) = 40, see work-class.ts) — deliberately with
// headroom (not exactly 40) so this LOAD scenario measures real latency
// under concurrency rather than accidentally self-saturating (that proof
// belongs to `saturation-and-recovery.ts`, which targets "maintenance"
// specifically because its capacity is small enough to saturate on
// purpose and deterministically).
const CONCURRENT_CALLS = 30;
const MAX_P95_MS = 2000;
const MAX_ERROR_RATE_PERCENT = 5;

export function interactiveLoadScenario(): ScenarioDefinition {
  return {
    name: "interactive-load",
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
          const result = await interactiveAuditRead(sql, tenantId);

          return {
            latencyMs: performance.now() - callStart,
            ok: result.ok
          };
        })
      );

      const wallClockDurationMs = performance.now() - startedAt;
      const metrics = summarizeWorkload(samples, wallClockDurationMs);
      const flattened = flattenWorkloadMetrics(metrics);

      const ok =
        metrics.latency.p95Ms <= MAX_P95_MS &&
        metrics.throughput.errorRatePercent <= MAX_ERROR_RATE_PERCENT;

      return {
        ok,
        detail: ok
          ? `${CONCURRENT_CALLS} concurrent interactive reads: p95=${metrics.latency.p95Ms.toFixed(1)}ms, error rate=${metrics.throughput.errorRatePercent.toFixed(1)}%.`
          : `Interactive load exceeded budget: p95=${metrics.latency.p95Ms.toFixed(1)}ms (max ${MAX_P95_MS}ms), error rate=${metrics.throughput.errorRatePercent.toFixed(1)}% (max ${MAX_ERROR_RATE_PERCENT}%).`,
        metrics: flattened
      };
    }
  };
}
