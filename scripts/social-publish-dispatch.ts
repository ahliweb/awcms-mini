/**
 * social-publish-dispatch.ts — `bun run social-publishing:dispatch`.
 *
 * Issue #643. Internal worker entrypoint for the social publish outbox
 * dispatcher (`src/modules/social-publishing/application/social-publish-dispatch.ts`)
 * — mirrors `scripts/object-sync-dispatch.ts` exactly (same per-tenant
 * bounded-passes loop, same `awcms_mini_worker` role via
 * `getWorkerDatabaseClient`). Not exposed over HTTP.
 *
 * This foundation issue ships ZERO real provider adapters
 * (`src/modules/social-publishing/infrastructure/social-provider-registry.ts`
 * starts empty) — every dispatched job today resolves to a terminal
 * `provider_not_registered` failure until #644/#645/#646 register a real
 * adapter from their own composition root (a future import added here or to
 * a small adapter-registration script run before this one).
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { dispatchSocialPublishQueue } from "../src/modules/social-publishing/application/social-publish-dispatch";

const MAX_PASSES_PER_TENANT = 20;

type TenantRow = { id: string };

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 045.
  const sql = getWorkerDatabaseClient();
  const correlationId = crypto.randomUUID();

  try {
    const tenants = (await sql`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as TenantRow[];

    let totalClaimed = 0;
    let totalPublished = 0;
    let totalRetried = 0;
    let totalFailed = 0;
    let totalRateLimited = 0;
    let totalNeedsReauth = 0;

    for (const tenant of tenants) {
      for (let pass = 0; pass < MAX_PASSES_PER_TENANT; pass += 1) {
        const result = await dispatchSocialPublishQueue(sql, tenant.id, {
          correlationId
        });

        totalClaimed += result.claimed;
        totalPublished += result.published;
        totalRetried += result.retried;
        totalFailed += result.failed;
        totalRateLimited += result.rateLimited;
        totalNeedsReauth += result.needsReauth;

        if (result.claimed === 0) {
          break;
        }
      }
    }

    console.log(
      `social-publishing:dispatch complete — correlationId=${correlationId} ` +
        `tenants=${tenants.length} claimed=${totalClaimed} published=${totalPublished} ` +
        `retried=${totalRetried} failed=${totalFailed} rateLimited=${totalRateLimited} ` +
        `needsReauth=${totalNeedsReauth}`
    );
  } catch (error) {
    logScriptFailure("social-publishing:dispatch FAILED", error);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
