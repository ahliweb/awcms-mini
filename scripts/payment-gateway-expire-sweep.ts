/**
 * `bun run payment-gateway:expire-sweep` (Issue #877) — expire live intents past
 * their window that never received a settling webhook, producing deterministic
 * safe state. DB-only under a per-tenant lease; no provider call.
 *
 * Usage: bun run payment-gateway:expire-sweep [--dry-run]
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { runExpireSweep } from "../src/modules/payment-gateway/application/reconciliation-engine";

async function main(): Promise<void> {
  const sql = getDatabaseClient();
  const dryRun = process.argv.includes("--dry-run");
  const correlationId = crypto.randomUUID();
  const result = await runExpireSweep(sql, { dryRun, correlationId });
  console.log(
    `payment-gateway:expire-sweep — tenants=${result.tenantsChecked} processed=${result.processed} expired=${result.changed} skipped=${result.tenantsSkipped}${dryRun ? " (dry-run)" : ""}`
  );
}

await main();
