/**
 * `bun run tenant-lifecycle:run-scheduled` (Issue #873) — a thin operational CLI
 * that applies ONE tenant's DUE scheduled lifecycle transition (trial/grace
 * expiry), reusing the same idempotent `runDueScheduleForTenant` engine the
 * scheduler path uses. Idempotent under concurrent workers (row-lock + state+
 * version-predicated update); DB-only and safe offline/LAN (no provider call).
 *
 * Usage:
 *   bun run tenant-lifecycle:run-scheduled <tenantId>
 *   LIFECYCLE_TENANT_ID=<tenantId> bun run tenant-lifecycle:run-scheduled
 *
 * SCOPE NOTE: deliberately PER-TENANT (a tenant id is required). A FLEET-WIDE
 * batch that scans every tenant's due schedules would need a purpose-built
 * cross-tenant read-model (ADR-0022 §6b — a platform operator is NOT a soft
 * super-tenant and never scans all tenants' RLS tables ad hoc); that is
 * intentionally deferred to the operations work (#880). Until then, run
 * per-tenant on a schedule (this script) or via the operator surface.
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { setTenantStatus } from "../src/modules/tenant-admin/application/tenant-onboarding";
import { runDueScheduleForTenant } from "../src/modules/tenant-lifecycle/application/lifecycle-scheduler";
import type { LifecycleEngineDeps } from "../src/modules/tenant-lifecycle/application/lifecycle-transition";

async function main(): Promise<void> {
  const tenantId = process.argv[2] ?? process.env.LIFECYCLE_TENANT_ID ?? "";
  if (!tenantId) {
    console.log(
      "tenant-lifecycle:run-scheduled — apply ONE tenant's DUE scheduled transition.\n" +
        "Usage: bun run tenant-lifecycle:run-scheduled <tenantId>\n" +
        "Fleet-wide batch scheduling is deferred to #880 (needs a cross-tenant read-model)."
    );
    return;
  }

  const sql = getDatabaseClient();
  const deps: LifecycleEngineDeps = {
    async projectTenantStatus(tx, id, active, actor) {
      await setTenantStatus(tx, id, active ? "active" : "inactive", actor);
    }
  };

  const result = await runDueScheduleForTenant(
    sql,
    tenantId,
    deps,
    { actorTenantUserId: null },
    new Date()
  );

  if (!result.ok) {
    console.log(`No lifecycle record for tenant ${tenantId}.`);
    return;
  }
  console.log(
    `tenant ${tenantId}: ${result.applied ? "APPLIED" : "no-op"} — ${result.note} (now "${result.state.state}").`
  );
}

await main();
