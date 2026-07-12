import { withTenant } from "../../../lib/database/tenant-context";
import { log } from "../../../lib/logging/logger";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { fetchPostTermIds } from "./blog-taxonomy-directory";
import { fetchBlogSettings } from "./blog-settings-directory";
import { evaluateContentQualityChecklistForContent } from "./content-quality-checklist-gate";
import type { NewsMediaPort } from "../../_shared/ports/news-media-port";

/**
 * Scheduled publishing (Issue #541, doc issue #541 §Scheduled Publishing
 * Rules). A post becomes due when `status = 'scheduled' AND scheduled_at <=
 * now()` — the same `awcms_mini_blog_posts` predicate every other lifecycle
 * transition in this module already checks (`isValidStatusTransition`
 * governs the *legality* of scheduled -> published; this job is the thing
 * that actually performs it once due, since there is no external
 * cron/provider integration in scope for #541).
 *
 * Issue #640 restructured this from a single set-based `UPDATE` into a
 * per-post loop: the content quality checklist must gate this transition
 * too, not just the interactive `POST .../publish`/`.../schedule` endpoints
 * — otherwise a tenant could bypass the checklist entirely by scheduling a
 * post BEFORE the tenant applied full-online R2-only mode (or before an
 * editor fixed a since-flagged problem) and simply waiting for it to become
 * due, the exact class of gap Issue #636's "restore revision" bypass
 * already taught this epic to close for every new write/transition path.
 * A post whose checklist fails at due-time is left `scheduled` (not
 * silently published, not silently un-scheduled) and reported via a
 * dedicated audit event — an operator/editor can inspect and fix it, then
 * either re-schedule or publish manually once ready. Still idempotent: a
 * post already `published`, still in the future, or left `scheduled` due to
 * a prior blocked attempt simply doesn't match the `WHERE`/isn't re-blocked
 * twice in a way that changes anything on a re-run. `mediaPort` is supplied
 * by the caller (`scripts/blog-scheduled-publish.ts`, the composition root,
 * per ADR-0011) — this file itself never imports `news_portal`.
 */
export type PublishDueScheduledPostsOptions = {
  now?: Date;
  correlationId?: string;
};

export type PublishDueScheduledPostsResult = {
  publishedCount: number;
  publishedPostIds: string[];
  blockedCount: number;
  blockedPostIds: string[];
};

type DuePostRow = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  content_json: Record<string, unknown>;
  content_text: string;
  featured_media_id: string | null;
  meta_description: string | null;
};

export async function publishDueScheduledPosts(
  sql: Bun.SQL,
  tenantId: string,
  mediaPort: NewsMediaPort,
  options: PublishDueScheduledPostsOptions = {}
): Promise<PublishDueScheduledPostsResult> {
  const now = options.now ?? new Date();
  const correlationId = options.correlationId;

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const due = (await tx`
        SELECT id, slug, title, excerpt, content_json, content_text,
               featured_media_id, meta_description
        FROM awcms_mini_blog_posts
        WHERE tenant_id = ${tenantId} AND status = 'scheduled'
          AND scheduled_at IS NOT NULL AND scheduled_at <= ${now}
          AND deleted_at IS NULL
        FOR UPDATE
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

        return {
          publishedCount: 0,
          publishedPostIds: [],
          blockedCount: 0,
          blockedPostIds: []
        };
      }

      const blogSettings = await fetchBlogSettings(tx, tenantId);
      const publishedPostIds: string[] = [];
      const blockedPostIds: string[] = [];

      for (const post of due) {
        const termIds = await fetchPostTermIds(tx, tenantId, post.id);
        const evaluateChecklist = () =>
          evaluateContentQualityChecklistForContent(
            tx,
            tenantId,
            "post",
            {
              title: post.title,
              slug: post.slug,
              excerpt: post.excerpt,
              metaDescription: post.meta_description,
              contentText: post.content_text,
              contentJson: post.content_json,
              featuredMediaId: post.featured_media_id
            },
            termIds.length,
            mediaPort,
            blogSettings.contentQualityChecklistPolicy
          );

        let checklist = await evaluateChecklist();

        /**
         * TOCTOU mitigation (security-auditor Medium finding, PR #725): the
         * post row itself is protected by the batch's own `FOR UPDATE` lock
         * (above), but the R2 media objects it references are NOT locked —
         * an editor could detach/invalidate the featured/gallery media
         * between this first evaluation and the `UPDATE` below, especially
         * for a large due-batch where earlier posts' evaluations/updates
         * push that gap out further. Re-running the evaluation immediately
         * before the `UPDATE` shrinks that window from "the rest of this
         * tenant's whole batch" down to one query round-trip — it doesn't
         * eliminate the race outright (that would need locking the
         * referenced media rows too, a bigger change touching the shared
         * `NewsMediaPort` every read-only preview endpoint also uses), but
         * closes the realistic exposure at negligible cost.
         */
        if (checklist.passed) {
          checklist = await evaluateChecklist();
        }

        if (!checklist.passed) {
          blockedPostIds.push(post.id);

          await recordAuditEvent(tx, {
            tenantId,
            moduleKey: "blog_content",
            action: "blog.post.scheduled_publish_blocked",
            resourceType: "blog_post",
            resourceId: post.id,
            severity: "warning",
            message: `Scheduled publish blocked by content quality checklist: ${post.slug}.`,
            attributes: {
              blockedRuleIds: checklist.blockers.map(
                (blocker) => blocker.ruleId
              )
            },
            correlationId
          });

          log("warning", "blog-content.post.scheduled_publish_blocked", {
            correlationId,
            tenantId,
            moduleKey: "blog_content",
            postId: post.id,
            slug: post.slug
          });

          continue;
        }

        await tx`
          UPDATE awcms_mini_blog_posts
          SET status = 'published',
              published_at = COALESCE(published_at, ${now}),
              scheduled_at = NULL,
              version = version + 1,
              updated_at = ${now}
          WHERE tenant_id = ${tenantId} AND id = ${post.id}
        `;

        publishedPostIds.push(post.id);

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
        message: `Scheduled publish ran: ${publishedPostIds.length} post(s) published, ${blockedPostIds.length} blocked.`,
        attributes: {
          publishedCount: publishedPostIds.length,
          blockedCount: blockedPostIds.length
        },
        correlationId
      });

      return {
        publishedCount: publishedPostIds.length,
        publishedPostIds,
        blockedCount: blockedPostIds.length,
        blockedPostIds
      };
    },
    { workClass: "maintenance" }
  );
}
