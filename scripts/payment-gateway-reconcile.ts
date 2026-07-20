/**
 * `bun run payment-gateway:reconcile` (Issue #877) — compare provider vs local
 * intent state (querying the provider OUTSIDE any transaction) and close drift
 * with an audited correction under a per-tenant lease. The final source of truth
 * beyond a single webhook (provider-outage-safe). Composition root: wires the
 * OPTIONAL `payment_outcome` binder for a reconciled settlement.
 *
 * Usage: bun run payment-gateway:reconcile [--dry-run]
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { runReconciliation } from "../src/modules/payment-gateway/application/reconciliation-engine";
import { paymentOutcomeBinder } from "../src/pages/api/v1/payment-gateway/_support";

async function main(): Promise<void> {
  const sql = getDatabaseClient();
  const dryRun = process.argv.includes("--dry-run");
  const correlationId = crypto.randomUUID();
  const result = await runReconciliation(
    sql,
    { dryRun, correlationId },
    {},
    paymentOutcomeBinder(correlationId)
  );
  console.log(
    `payment-gateway:reconcile — tenants=${result.tenantsChecked} processed=${result.processed} changed=${result.changed} skipped=${result.tenantsSkipped}${dryRun ? " (dry-run)" : ""}`
  );
}

await main();
