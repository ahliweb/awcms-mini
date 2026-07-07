import { withTenant } from "../../../lib/database/tenant-context";
import { log } from "../../../lib/logging/logger";
import { recordAuditEvent } from "../../logging/application/audit-log";

/**
 * Scheduled publishing (Issue #541, doc issue #541 §Scheduled Publishing
 * Rules). A post becomes due when `status = 'scheduled' AND scheduled_at <=
 * now()` — the same `awcms_mini_blog_posts` predicate every other lifecycle
 * transition in this module already checks (`isValidStatusTransition`
 * governs the *legality* of scheduled -> published; this job is the thing
 * that actually performs it once due, since there is no external
 * cron/provider integration in scope for #541). One set-based `UPDATE` per
 * tenant call — idempotent by construction: a post that's already
 * `published` (or whose `scheduled_at` is still in the future) simply
 * doesn't match the `WHERE` clause on a re-run, so calling this twice for
 * the same tenant at the same `now` is a no-op the second time. Called from
 * `scripts/blog-scheduled-publish.ts`, one per active tenant — never calls
 * an external provider (ADR-0006: providers are never called inside a DB
 * transaction; this job has no provider to call in the first place).
 */
export type PublishDueScheduledPostsOptions = {
  now?: Date;
  correlationId?: string;
};

export type PublishDueScheduledPostsResult = {
  publishedCount: number;
  publishedPostIds: string[];
};

type DuePostRow = { id: string; slug: string };

export async function publishDueScheduledPosts(
  sql: Bun.SQL,
  tenantId: string,
  options: PublishDueScheduledPostsOptions = {}
): Promise<PublishDueScheduledPostsResult> {
  const now = options.now ?? new Date();
  const correlationId = options.correlationId;

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const due = (await tx`
        UPDATE awcms_mini_blog_posts
        SET status = 'published',
            published_at = COALESCE(published_at, ${now}),
            scheduled_at = NULL,
            version = version + 1,
            updated_at = ${now}
        WHERE tenant_id = ${tenantId} AND status = 'scheduled'
          AND scheduled_at IS NOT NULL AND scheduled_at <= ${now}
          AND deleted_at IS NULL
        RETURNING id, slug
      `) as DuePostRow[];

      if (due.length === 0) {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: "blog_content",
          action: "blog.post.scheduled_publish_skipped",
          resourceType: "blog_post",
          severity: "info",
          message: "Scheduled publish ran: no due posts.",
          correlationId
        });

        return { publishedCount: 0, publishedPostIds: [] };
      }

      for (const post of due) {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: "blog_content",
          action: "blog.post.published",
          resourceType: "blog_post",
          resourceId: post.id,
          severity: "info",
          message: `Blog post published by scheduled publish: ${post.slug}.`,
          correlationId
        });

        log("info", "blog-content.post.published", {
          correlationId,
          tenantId,
          moduleKey: "blog_content",
          postId: post.id,
          slug: post.slug,
          trigger: "scheduled_publish"
        });
      }

      await recordAuditEvent(tx, {
        tenantId,
        moduleKey: "blog_content",
        action: "blog.post.scheduled_publish_executed",
        resourceType: "blog_post",
        severity: "info",
        message: `Scheduled publish ran: ${due.length} post(s) published.`,
        attributes: { publishedCount: due.length },
        correlationId
      });

      return {
        publishedCount: due.length,
        publishedPostIds: due.map((post) => post.id)
      };
    },
    { workClass: "maintenance" }
  );
}
