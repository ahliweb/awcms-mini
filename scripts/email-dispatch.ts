/**
 * email-dispatch.ts — `bun run email:dispatch`.
 *
 * Issue #495 (epic #492). Internal worker entrypoint for the email
 * dispatcher (`src/modules/email/application/email-dispatch.ts`) — intended
 * to run on a schedule (cron/systemd timer/k8s CronJob), not exposed over
 * HTTP. Mirrors `scripts/object-sync-dispatch.ts` exactly: iterates every
 * `active` tenant and drains its due `awcms_mini_email_messages` backlog in
 * batches, looping per tenant until a batch claims nothing or
 * `MAX_PASSES_PER_TENANT` is hit.
 *
 * No-op (claims nothing, exits 0) when `EMAIL_ENABLED` is not `"true"` —
 * see `dispatchEmailQueue`'s own early return.
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { dispatchEmailQueue } from "../src/modules/email/application/email-dispatch";

const MAX_PASSES_PER_TENANT = 20;

type TenantRow = { id: string };

async function main() {
  const sql = getDatabaseClient();
  const correlationId = crypto.randomUUID();

  try {
    const tenants = (await sql`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as TenantRow[];

    let totalClaimed = 0;
    let totalSent = 0;
    let totalRetried = 0;
    let totalFailed = 0;

    for (const tenant of tenants) {
      for (let pass = 0; pass < MAX_PASSES_PER_TENANT; pass += 1) {
        const result = await dispatchEmailQueue(sql, tenant.id, {
          correlationId
        });

        totalClaimed += result.claimed;
        totalSent += result.sent;
        totalRetried += result.retried;
        totalFailed += result.failed;

        if (result.claimed === 0) {
          break;
        }
      }
    }

    console.log(
      `email:dispatch complete — correlationId=${correlationId} ` +
        `tenants=${tenants.length} claimed=${totalClaimed} sent=${totalSent} ` +
        `retried=${totalRetried} failed=${totalFailed}`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`email:dispatch FAILED — ${detail}`);
    process.exitCode = 1;
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
