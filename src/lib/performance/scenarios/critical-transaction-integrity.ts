/**
 * "critical_transaction" workload scenario (Issue #744, epic #738
 * platform-evolution) — the issue's "critical idempotent transactions
 * remain atomic... under load" minimum validation target. Fires N
 * concurrent `criticalIdempotentWrite` calls (`workload.ts`) that all share
 * the SAME idempotency key — a deliberate race on the REAL
 * `awcms_mini_idempotency_keys` store — then asserts, against the real
 * database, that EXACTLY ONE row was persisted for that key, no matter how
 * many concurrent callers raced for it. This is the concrete atomicity
 * proof: a regression that let two concurrent racers both commit would
 * show up here as `rowCount !== 1`, not just as a slower response.
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
import { getPerformanceSql, primaryTenantId } from "../scenario-context";
import { criticalIdempotentWrite } from "../workload";

const RACING_CALLS = 20;

export function criticalTransactionIntegrityScenario(): ScenarioDefinition {
  return {
    name: "critical-transaction-integrity",
    tier: "safe",
    timeoutMs: 15_000,
    async run(_ctx: ScenarioContext): Promise<ScenarioOutcome> {
      const sql = getPerformanceSql();
      const tenantId = primaryTenantId();
      const idempotencyKey = `perf-scenario-race-${Date.now()}`;
      const startedAt = performance.now();

      const samples: CallSample[] = await Promise.all(
        Array.from({ length: RACING_CALLS }, async () => {
          const callStart = performance.now();
          const result = await criticalIdempotentWrite(
            sql,
            tenantId,
            idempotencyKey
          );

          return { latencyMs: performance.now() - callStart, ok: result.ok };
        })
      );

      const wallClockDurationMs = performance.now() - startedAt;
      const metrics = summarizeWorkload(samples, wallClockDurationMs);

      const persistedCount = await withTenant(
        sql,
        tenantId,
        async (tx) => {
          const rows = (await tx`
            SELECT count(*)::int AS row_count
            FROM awcms_mini_idempotency_keys
            WHERE tenant_id = ${tenantId}
              AND request_scope = 'performance.synthetic.critical_transaction'
              AND idempotency_key = ${idempotencyKey}
          `) as { row_count: number }[];

          return rows[0]?.row_count ?? 0;
        },
        { workClass: "interactive" }
      );

      const everyCallerSucceeded = samples.every((sample) => sample.ok);
      const ok = persistedCount === 1 && everyCallerSucceeded;

      return {
        ok,
        detail: ok
          ? `${RACING_CALLS} concurrent racers for the same idempotency key: ` +
            `exactly 1 row persisted, every caller received a successful (replayed or original) response.`
          : `Atomicity violation or caller failure: persistedCount=${persistedCount} (expected 1), ` +
            `every caller ok=${everyCallerSucceeded}.`,
        metrics: {
          ...flattenWorkloadMetrics(metrics),
          racingCalls: RACING_CALLS,
          persistedRowCount: persistedCount
        }
      };
    }
  };
}
