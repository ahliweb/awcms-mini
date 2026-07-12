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
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { publishDueScheduledPosts } from "../src/modules/blog-content/application/blog-scheduled-publish";
import { newsMediaPortAdapter } from "../src/modules/news-portal/application/news-media-port-adapter";

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

    for (const tenant of tenants) {
      const result = await publishDueScheduledPosts(
        sql,
        tenant.id,
        newsMediaPortAdapter,
        { now, correlationId }
      );

      totalPublished += result.publishedCount;
      totalBlocked += result.blockedCount;
    }

    console.log(
      `blog:publish:scheduled complete — correlationId=${correlationId} ` +
        `tenants=${tenants.length} published=${totalPublished} blocked=${totalBlocked}`
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
