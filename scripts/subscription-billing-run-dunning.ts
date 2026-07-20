/**
 * `bun run subscription-billing:run-dunning` (Issue #876) — run dunning for
 * past-due issued invoices under a per-tenant lease; each attempt REQUESTS a
 * lifecycle transition through the #873 `lifecycle_transition` port (fail-closed)
 * — billing never mutates tenant lifecycle state directly. DB-only and safe
 * offline/LAN. This CLI is the COMPOSITION ROOT wiring the lifecycle port
 * (with the mandatory tenant-status projector) into the dunning engine deps.
 *
 * Usage: bun run subscription-billing:run-dunning [--state past_due|grace|suspended] [--dry-run]
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { setTenantStatus } from "../src/modules/tenant-admin/application/tenant-onboarding";
import { createLifecycleTransitionPort } from "../src/modules/tenant-lifecycle/application/lifecycle-transition-port-adapter";
import type { LifecycleEngineDeps } from "../src/modules/tenant-lifecycle/application/lifecycle-transition";
import type { LifecycleState } from "../src/modules/_shared/ports/tenant-lifecycle-port";
import { runBillingDunning } from "../src/modules/subscription-billing/application/billing-jobs";
import type { DunningEngineDeps } from "../src/modules/subscription-billing/application/dunning-engine";

const ALLOWED: LifecycleState[] = ["past_due", "grace", "suspended"];

async function main(): Promise<void> {
  const sql = getDatabaseClient();
  const dryRun = process.argv.includes("--dry-run");
  const stateIdx = process.argv.indexOf("--state");
  const requested = (
    stateIdx >= 0 ? process.argv[stateIdx + 1] : "past_due"
  ) as LifecycleState;
  if (!ALLOWED.includes(requested)) {
    console.log(
      "Usage: bun run subscription-billing:run-dunning [--state past_due|grace|suspended] [--dry-run]"
    );
    return;
  }

  const lifecycleDeps: LifecycleEngineDeps = {
    async projectTenantStatus(tx, tenantId, active, actor) {
      await setTenantStatus(
        tx,
        tenantId,
        active ? "active" : "inactive",
        actor
      );
    }
  };
  const buildDunningDeps = (
    tx: Bun.SQL,
    tenantId: string
  ): DunningEngineDeps => ({
    lifecycle: createLifecycleTransitionPort(tx, tenantId, lifecycleDeps)
  });

  const result = await runBillingDunning(
    sql,
    { dryRun, correlationId: crypto.randomUUID() },
    buildDunningDeps,
    requested
  );
  console.log(
    `subscription-billing:run-dunning — tenants=${result.tenantsChecked} attempts=${result.attemptsMade} skipped=${result.tenantsSkipped} state=${requested}${dryRun ? " (dry-run)" : ""}`
  );
}

await main();
