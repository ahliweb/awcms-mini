/**
 * blog-scheduled-publish.ts — `bun run blog:publish:scheduled`.
 *
 * Issue #541. Internal worker entrypoint mirroring `scripts/form-draft-
 * purge.ts` — not exposed over HTTP, run on a schedule (cron/systemd
 * timer/k8s CronJob). Publishes every due `status = 'scheduled'` post
 * (`scheduled_at <= now()`) for every active tenant via
 * `publishDueScheduledPosts`. Idempotent: a post already published, still
 * in the future, or left `scheduled` after a blocked checklist attempt
 * simply doesn't get re-published on a re-run.
 *
 * Issue #640: this script is the composition root (ADR-0011) that wires
 * `news_portal`'s `NewsMediaPort` implementation into `blog_content`'s
 * scheduled-publish job, so the content quality checklist can gate this
 * transition exactly like the interactive publish/schedule endpoints —
 * `blog-scheduled-publish.ts` itself never imports `news_portal` directly.
 *
 * Issue #643 (epic `social_publishing`): this script is ALSO the
 * composition root that wires `social_publishing`'s
 * `SocialPublishingPort` — `createSocialPublishingPortAdapter(newsMediaPortAdapter)`
 * — into `publishDueScheduledPosts`, so a scheduled post that becomes due
 * also gets its social-publishing outbox jobs created (trigger
 * `scheduled_published`), exactly like the manual publish route
 * (`pages/api/v1/blog/posts/[id]/publish.ts`) does. `blog-scheduled-
 * publish.ts` (the application-layer file) still never imports
 * `social_publishing` directly — only this composition-root script does.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { publishDueScheduledPosts } from "../src/modules/blog-content/application/blog-scheduled-publish";
import { newsMediaPortAdapter } from "../src/modules/news-portal/application/news-media-port-adapter";
import { createSocialPublishingPortAdapter } from "../src/modules/social-publishing/application/social-publishing-port-adapter";

const socialPublishingPort =
  createSocialPublishingPortAdapter(newsMediaPortAdapter);

type TenantRow = { id: string };

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 045.
  const sql = getWorkerDatabaseClient();
  const correlationId = crypto.randomUUID();
  const now = new Date();

  try {
    const tenants = (await sql`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as TenantRow[];

    let totalPublished = 0;
    let totalBlocked = 0;
    let partialTenants = 0;

    for (const tenant of tenants) {
      const result = await publishDueScheduledPosts(
        sql,
        tenant.id,
        newsMediaPortAdapter,
        { now, correlationId },
        socialPublishingPort
      );

      totalPublished += result.publishedCount;
      totalBlocked += result.blockedCount;
      if (result.partial) {
        // Issue #835 §6: this tenant had a full batch this run; its remaining
        // due posts are picked up on the next scheduled run (idempotent).
        partialTenants += 1;
      }
    }

    console.log(
      `blog:publish:scheduled complete — correlationId=${correlationId} ` +
        `tenants=${tenants.length} published=${totalPublished} blocked=${totalBlocked} ` +
        `partialTenants=${partialTenants}`
    );
  } catch (error) {
    logScriptFailure("blog:publish:scheduled FAILED", error);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
