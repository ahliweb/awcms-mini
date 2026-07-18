/**
 * social-publish-dispatch.ts — `bun run social-publishing:dispatch`.
 *
 * Issue #643. Internal worker entrypoint for the social publish outbox
 * dispatcher (`src/modules/social-publishing/application/social-publish-dispatch.ts`)
 * — mirrors `scripts/object-sync-dispatch.ts` exactly (same per-tenant
 * bounded-passes loop, same `awcms_mini_worker` role via
 * `getWorkerDatabaseClient`). Not exposed over HTTP.
 *
 * The foundation issue (#643) shipped ZERO real provider adapters
 * (`src/modules/social-publishing/infrastructure/social-provider-registry.ts`
 * starts empty) — every job for a provider with no adapter registered
 * resolves to a terminal `provider_not_registered` failure. Each adapter
 * issue registers itself here from its own composition root (Issue #645's
 * `registerLinkedInProviderAdapterIfEnabled` below is the first; #644 Meta
 * and #646 Telegram add their own equivalent import + call, each
 * independently, additive to this list).
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { dispatchSocialPublishQueue } from "../src/modules/social-publishing/application/social-publish-dispatch";
import { registerLinkedInProviderAdapterIfEnabled } from "../src/modules/social-publishing/infrastructure/linkedin-provider-adapter";
// Issue #859 (epic #818): this dispatcher is the real publish path, so it is
// the composition root that injects `news_portal`'s `news_media` capability
// (the R2 public base URL the LinkedIn adapter's image-trust check needs)
// into the adapter — replacing the former static cross-module import that had
// forced `news_portal` to be a HARD dependency of `social_publishing`.
import { newsMediaPortAdapter } from "../src/modules/news-portal/application/news-media-port-adapter";
// Issue #646 — side-effect import registers the real Telegram adapter into
// `social-provider-registry.ts` for this process. See
// `telegram-provider-registration.ts`'s own header comment for why this is
// unconditional and why every adapter gets its own such import here.
import "../src/modules/social-publishing/infrastructure/telegram-provider-registration";

const MAX_PASSES_PER_TENANT = 20;

type TenantRow = { id: string };

async function main() {
  // Composition-root adapter registration (Issue #645) — a no-op unless
  // LINKEDIN_PROVIDER_ENABLED=true. Future adapter issues (#644 Meta, #646
  // Telegram) add their own equivalent registration call here, each
  // independently — see `social-provider-registry.ts`'s header comment.
  // The `newsMediaPortAdapter` argument (Issue #859) supplies the trusted R2
  // public base URL for image posts; this is the ONLY process that both
  // publishes AND needs that capability, so it is the one place the concrete
  // `news_portal` adapter is wired in.
  registerLinkedInProviderAdapterIfEnabled(process.env, newsMediaPortAdapter);

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
