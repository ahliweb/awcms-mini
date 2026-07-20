/**
 * `bun run payment-gateway:dispatch-outbox` (Issue #877) — dispatch pending
 * provider work (checkout create / refund request) OUTSIDE any DB transaction
 * (ADR-0006), with bounded retry/backoff, circuit breaker, and DLQ, under a
 * per-tenant lease. This CLI is the COMPOSITION ROOT: it wires the OPTIONAL
 * `payment_outcome` binder (which forwards a settled/refunded outcome to
 * subscription_billing's own write path) into the dispatch engine. With no
 * provider adapter configured the queue simply stays pending.
 *
 * Usage: bun run payment-gateway:dispatch-outbox [--dry-run]
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { runOutboxDispatch } from "../src/modules/payment-gateway/application/outbox-dispatch";
import { paymentOutcomeBinder } from "../src/pages/api/v1/payment-gateway/_support";

async function main(): Promise<void> {
  const sql = getDatabaseClient();
  const dryRun = process.argv.includes("--dry-run");
  const correlationId = crypto.randomUUID();
  const result = await runOutboxDispatch(
    sql,
    { dryRun, correlationId },
    {},
    paymentOutcomeBinder(correlationId)
  );
  console.log(
    `payment-gateway:dispatch-outbox — tenants=${result.tenantsChecked} dispatched=${result.dispatched} ok=${result.succeeded} retried=${result.retried} dead=${result.deadLettered} skipped=${result.tenantsSkipped}${dryRun ? " (dry-run)" : ""}`
  );
}

await main();
