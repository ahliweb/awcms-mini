/**
 * Mixed-workload scenario (Issue #744, epic #738 platform-evolution) — the
 * issue's "reporting load cannot cause critical transaction correctness
 * failure" minimum validation target. Runs a burst of `reportingAggregateRead`
 * calls (`reporting` work class) CONCURRENTLY with a batch of
 * `criticalIdempotentWrite` calls, each with its OWN unique idempotency key
 * (`critical_transaction` work class) — proving the two work classes don't
 * starve or corrupt each other: every critical write must still land
 * exactly once, and the reporting reads must still complete.
 */
import type {
  ScenarioContext,
  ScenarioDefinition,
  ScenarioOutcome
} from "../../resilience/scenario-runner";
import { withTenant } from "../../database/tenant-context";
import {
  flattenWorkloadMetrics,
  summarizeWorkload,
  type CallSample
} from "../metrics-aggregate";
import {
  allTenantIds,
  getPerformanceSql,
  primaryTenantId
} from "../scenario-context";
import { criticalIdempotentWrite, reportingAggregateRead } from "../workload";

// Below "reporting"'s own total capacity (max concurrency 4 x (1 +
// default queue multiplier 4) = 20, see work-class.ts) — with headroom, so
// this scenario's reporting reads are expected to all genuinely succeed
// (not merely "complete", whether ok or rejected) while critical writes
// run concurrently — a stronger, more realistic mixed-workload proof than
// deliberately self-saturating (that proof belongs to
// `saturation-and-recovery.ts`).
const REPORTING_CALLS = 16;
const CRITICAL_WRITE_CALLS = 15;

export function reportingUnderLoadScenario(): ScenarioDefinition {
  return {
    name: "reporting-under-load",
    tier: "safe",
    timeoutMs: 20_000,
    async run(_ctx: ScenarioContext): Promise<ScenarioOutcome> {
      const sql = getPerformanceSql();
      const tenantIds = allTenantIds();
      const primaryTenant = primaryTenantId();
      const runId = Date.now();
      const startedAt = performance.now();

      const reportingSamples: CallSample[] = [];
      const criticalSamples: CallSample[] = [];
      const expectedKeys = Array.from(
        { length: CRITICAL_WRITE_CALLS },
        (_unused, index) => `perf-mixed-${runId}-${index}`
      );

      await Promise.all([
        ...Array.from({ length: REPORTING_CALLS }, async (_unused, index) => {
          const tenantId = tenantIds[index % tenantIds.length]!;
          const callStart = performance.now();
          const result = await reportingAggregateRead(sql, tenantId);
          reportingSamples.push({
            latencyMs: performance.now() - callStart,
            ok: result.ok
          });
        }),
        ...expectedKeys.map(async (key) => {
          const callStart = performance.now();
          const result = await criticalIdempotentWrite(sql, primaryTenant, key);
          criticalSamples.push({
            latencyMs: performance.now() - callStart,
            ok: result.ok
          });
        })
      ]);

      const wallClockDurationMs = performance.now() - startedAt;
      const reportingMetrics = summarizeWorkload(
        reportingSamples,
        wallClockDurationMs
      );
      const criticalMetrics = summarizeWorkload(
        criticalSamples,
        wallClockDurationMs
      );

      const persistedCount = await withTenant(
        sql,
        primaryTenant,
        async (tx) => {
          const rows = (await tx`
            SELECT count(*)::int AS row_count
            FROM awcms_mini_idempotency_keys
            WHERE tenant_id = ${primaryTenant}
              AND request_scope = 'performance.synthetic.critical_transaction'
              AND idempotency_key = ANY(${tx.array(expectedKeys, "text")})
          `) as { row_count: number }[];

          return rows[0]?.row_count ?? 0;
        },
        { workClass: "interactive" }
      );

      const criticalCorrect =
        persistedCount === CRITICAL_WRITE_CALLS &&
        criticalSamples.every((sample) => sample.ok);
      const reportingSucceeded =
        reportingSamples.length === REPORTING_CALLS &&
        reportingSamples.every((sample) => sample.ok);
      const ok = criticalCorrect && reportingSucceeded;

      return {
        ok,
        detail: ok
          ? `${CRITICAL_WRITE_CALLS} unique critical writes all persisted correctly ` +
            `(${persistedCount}/${CRITICAL_WRITE_CALLS}) while ${REPORTING_CALLS} concurrent reporting reads all succeeded.`
          : `Reporting load correctness failure: persistedCount=${persistedCount}/${CRITICAL_WRITE_CALLS}, ` +
            `reportingSucceeded=${reportingSucceeded} (${reportingSamples.filter((s) => s.ok).length}/${REPORTING_CALLS} ok).`,
        metrics: {
          ...flattenWorkloadMetrics(reportingMetrics, "reporting"),
          ...flattenWorkloadMetrics(criticalMetrics, "critical"),
          expectedCriticalWrites: CRITICAL_WRITE_CALLS,
          persistedCriticalWrites: persistedCount
        }
      };
    }
  };
}
