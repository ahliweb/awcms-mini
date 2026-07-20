/**
 * `bun run tenant-provisioning:reconcile` (Issue #872) — a thin operational CLI
 * that runs the NON-DESTRUCTIVE desired-vs-actual reconciliation for ONE
 * provisioned tenant (given its id), reusing the same `reconcileProvisioning`
 * engine the REST endpoint calls. It reports drift + safe operator actions and
 * NEVER auto-fixes (ADR-0022 §9).
 *
 * Usage:
 *   bun run tenant-provisioning:reconcile <tenantId>
 *   PROVISIONING_TENANT_ID=<tenantId> bun run tenant-provisioning:reconcile
 *
 * SCOPE NOTE: this is deliberately PER-TENANT (a tenant id is required). A
 * FLEET-WIDE batch that scans every provisioned tenant would need a
 * purpose-built cross-tenant read-model (ADR-0022 §6b — a platform operator is
 * NOT a soft super-tenant and never scans all tenants' RLS tables ad hoc); that
 * is intentionally deferred to the operations/reporting work (#880). Until
 * then, reconciliation is on-demand, one tenant at a time, via this script or
 * the `POST /api/v1/tenant-provisioning/tenants/{tenantId}/reconcile` endpoint.
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { withTenant } from "../src/lib/database/tenant-context";
import { findRequestByTenant } from "../src/modules/tenant-provisioning/application/provisioning-directory";
import { reconcileProvisioning } from "../src/modules/tenant-provisioning/application/provisioning-orchestrator";

async function main(): Promise<void> {
  const tenantId = process.argv[2] ?? process.env.PROVISIONING_TENANT_ID ?? "";
  if (!tenantId) {
    console.log(
      "tenant-provisioning:reconcile — reconcile ONE provisioned tenant.\n" +
        "Usage: bun run tenant-provisioning:reconcile <tenantId>\n" +
        "Fleet-wide batch reconciliation is deferred to #880 (needs a cross-tenant read-model)."
    );
    return;
  }

  const sql = getDatabaseClient();
  const requestId = await withTenant(sql, tenantId, async (tx) => {
    const request = await findRequestByTenant(tx, tenantId);
    return request ? request.id : null;
  });

  if (!requestId) {
    console.log(`No provisioning run found for tenant ${tenantId}.`);
    return;
  }

  const result = await reconcileProvisioning(sql, tenantId, requestId, {
    actorTenantUserId: null
  });

  if (!result.ok) {
    console.log(
      `Reconcile skipped for tenant ${tenantId}: ${result.reason}${
        "status" in result ? ` (${result.status})` : ""
      }. Only a provisioned run can be reconciled.`
    );
    return;
  }

  console.log(
    `Reconcile ${result.status} for tenant ${tenantId} — ${result.drift.length} drift item(s); no auto-fix applied.`
  );
  if (result.drift.length > 0) {
    console.log(JSON.stringify(result.drift, null, 2));
  }
}

await main();
