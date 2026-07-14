/**
 * Read-only metrics snapshot for `organization_structure` (Issue #749,
 * epic #738 platform-evolution Wave 2, ADR-0016) — `bun run
 * organization-structure:metrics-snapshot`. Same "iterate active tenants,
 * `withTenant` per tenant, gauge set per pass" shape
 * `identity-access/application/business-scope-expiry-job.ts` establishes,
 * but simpler: this is a single READ pass per tenant (no backlog to drain,
 * no `runBoundedBatches`), never mutates a row.
 *
 * Feeds four gauges/counters declared in
 * `src/lib/observability/metrics-port.ts`: active units, hierarchy max
 * depth, and expiring-soon assignments (all gauges, sampled per run); the
 * invalid/cyclic-attempt counter is NOT touched here — it is incremented
 * at the point of rejection by `organization-unit-hierarchy-service.ts`
 * itself, not sampled by this snapshot.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { fetchActiveTenants } from "../../../lib/jobs/batching";
import { recordGauge } from "../../../lib/observability/metrics-port";
import { computeCurrentMaxDepth } from "./organization-unit-hierarchy-service";
import { countExpiringSoonAssignments } from "./organization-unit-assignment-service";

export type OrganizationStructureMetricsSnapshotResult = {
  tenantsChecked: number;
};

async function snapshotForTenant(
  sql: Bun.SQL,
  tenantId: string,
  now: Date
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    const activeUnitsRows = (await tx`
      SELECT count(*)::int AS count
      FROM awcms_mini_organization_units
      WHERE tenant_id = ${tenantId} AND status = 'active' AND deleted_at IS NULL
        AND effective_from <= ${now} AND (effective_to IS NULL OR effective_to > ${now})
    `) as { count: number }[];

    const maxDepth = await computeCurrentMaxDepth(tx, tenantId);
    const expiringSoon = await countExpiringSoonAssignments(tx, tenantId, now);

    recordGauge(
      "organization_structure_active_units_total",
      activeUnitsRows[0]?.count ?? 0
    );
    recordGauge("organization_structure_hierarchy_max_depth", maxDepth);
    recordGauge(
      "organization_structure_assignments_expiring_total",
      expiringSoon
    );
  });
}

/** Runs the snapshot for every active tenant. Read-only — safe to run as often as desired, and safe in every deployment profile (offline-lan-safe, no external provider). */
export async function runOrganizationStructureMetricsSnapshot(
  sql: Bun.SQL,
  now: Date = new Date()
): Promise<OrganizationStructureMetricsSnapshotResult> {
  const tenants = await fetchActiveTenants(sql);

  for (const tenant of tenants) {
    await snapshotForTenant(sql, tenant.id, now);
  }

  return { tenantsChecked: tenants.length };
}
