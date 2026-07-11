/**
 * blog-scheduled-publish.ts — `bun run blog:publish:scheduled`.
 *
 * Issue #541. Internal worker entrypoint mirroring `scripts/form-draft-
 * purge.ts` — not exposed over HTTP, run on a schedule (cron/systemd
 * timer/k8s CronJob). Publishes every due `status = 'scheduled'` post
 * (`scheduled_at <= now()`) for every active tenant, one `UPDATE` per
 * tenant via `publishDueScheduledPosts`. Idempotent: a post already
 * published or still in the future simply doesn't match on a re-run.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { publishDueScheduledPosts } from "../src/modules/blog-content/application/blog-scheduled-publish";

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

    for (const tenant of tenants) {
      const result = await publishDueScheduledPosts(sql, tenant.id, {
        now,
        correlationId
      });

      totalPublished += result.publishedCount;
    }

    console.log(
      `blog:publish:scheduled complete — correlationId=${correlationId} ` +
        `tenants=${tenants.length} published=${totalPublished}`
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
