/**
 * Usage aggregation job orchestration (Issue #875, epic #868, ADR-0022).
 * Extracted from `scripts/usage-metering-aggregate.ts` so integration tests can
 * drive real per-tenant iteration + bounded-pass draining without spawning a
 * subprocess (same pattern as `runAuditLogPurge`).
 *
 * Per pass, per active tenant, `aggregateTenant` claims the tenant's cursor
 * lease, drains one bounded batch of the merged event+correction stream,
 * recomputes every touched window FROM SOURCE (idempotent replay — never
 * double-counts), advances the checkpoint, and releases the lease — all inside
 * ONE `withTenant` transaction. Because the lease lives and dies in that single
 * transaction (never held across separate transactions), there is no
 * cross-transaction fencing hazard; `iterateTenantsInBatches` loops fresh
 * transactions until every tenant's backlog is drained (or the pass-count safety
 * bound is hit -> `status: "partial"`).
 */
import { withTenant } from "../../../lib/database/tenant-context";
import {
  fetchActiveTenants,
  iterateTenantsInBatches
} from "../../../lib/jobs/batching";
import type { JobContext } from "../../../lib/jobs/job-runner";
import { aggregateTenant } from "./aggregation-engine";
import type { SaasContractRegistry } from "./meter-registry";

export type UsageAggregationOptions = {
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Forwarded to `aggregateTenant`'s bounded batch limit. */
  batchLimit?: number;
  /** Forwarded to `iterateTenantsInBatches`' `maxPasses` (defaults to `DEFAULT_MAX_PASSES`). */
  maxPasses?: number;
  /** Stable lease holder id for this run. Defaults to a random id. */
  leaseHolder?: string;
};

export type UsageAggregationResult = {
  tenantsChecked: number;
  totalProcessed: number;
  /** Tenant ids whose backlog was NOT fully drained this run (hit the pass-count safety bound). Non-empty -> `status: "partial"`. */
  tenantsHitPassLimit: string[];
};

export async function runUsageAggregation(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  registry: SaasContractRegistry,
  options: UsageAggregationOptions = {}
): Promise<UsageAggregationResult> {
  const now = options.now ?? new Date();
  const leaseHolder = options.leaseHolder ?? crypto.randomUUID();

  // Dry-run: report how many tenants WOULD be visited, without claiming a lease
  // or mutating any aggregate/checkpoint.
  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);
    return {
      tenantsChecked: tenants.length,
      totalProcessed: 0,
      tenantsHitPassLimit: []
    };
  }

  const { tenants, totalCount, perTenant } = await iterateTenantsInBatches(
    sql,
    async (tenantId) => {
      const result = await withTenant(
        sql,
        tenantId,
        async (tx) =>
          aggregateTenant(tx, tenantId, registry, {
            leaseHolder,
            batchLimit: options.batchLimit,
            now
          }),
        { workClass: "maintenance" }
      );
      // A skipped pass (another worker holds a fresh lease) drains nothing this
      // round; report 0 so the tenant loop moves on rather than spinning.
      return { count: result.skipped ? 0 : result.processed };
    },
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  const tenantsHitPassLimit = [...perTenant.entries()]
    .filter(([, outcome]) => outcome.hitPassLimit)
    .map(([tenantId]) => tenantId);

  return {
    tenantsChecked: tenants.length,
    totalProcessed: totalCount,
    tenantsHitPassLimit
  };
}
