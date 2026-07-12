import type { NewsMediaPort } from "../../_shared/ports/news-media-port";
import { log } from "../../../lib/logging/logger";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { isSocialPublishingDeploymentActive } from "../domain/social-publishing-config";
import type { SocialPublishTriggerEvent } from "../domain/social-publish-rule-validation";
import {
  buildArticleCanonicalUrl,
  resolvePrimaryVerifiedDomainHostname
} from "./article-canonical-url";
import { listEligibleSocialPublishRulesForTrigger } from "./social-publish-rule-directory";
import { fetchActiveCaptionTemplate } from "./social-publish-template-directory";
import { fetchSocialPublishingSettings } from "./social-publishing-settings-directory";
import { renderSocialPublishCaption } from "../domain/social-publish-template-validation";
import { buildSocialPublishIdempotencyKey } from "../domain/social-publish-idempotency";

export type PublishedArticleSnapshot = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  featuredMediaId: string | null;
  /** Blog content's own effective public base path (e.g. `/news`) — resolved by the caller (composition root) via `blog_content`'s `fetchEffectivePublicRouteSettings`. Never re-derived here (see `article-canonical-url.ts`'s header comment on why this stays a caller-supplied parameter rather than a cross-module import). */
  publicBasePath: string;
};

export type CreateSocialPublishJobsResult = {
  jobsCreated: number;
  skippedReason?:
    | "deployment_disabled"
    | "tenant_auto_publishing_disabled"
    | "no_verified_domain"
    | "no_eligible_rules";
};

const MODULE_KEY = "social_publishing";

/**
 * The outbox PRODUCER (Issue #643 acceptance criterion: "Publishing jobs
 * are created after eligible article publish event"). Called from the
 * composition root's `SocialPublishingPort` adapter, itself called from
 * `blog_content`'s publish route/scheduled-publish worker RIGHT AFTER an
 * article transitions to `published` — inside the SAME transaction as that
 * transition (plain DB writes only, no external call, ADR-0006 compliant:
 * writing an outbox row atomically with the business event it originates
 * from is the correct half of the outbox pattern; only the actual provider
 * call, made later by `social-publish-dispatch.ts`, must stay outside any
 * transaction).
 *
 * Every exit before "insert rows" is a documented SKIP, never a thrown
 * error — a publish transaction must never fail because social publishing
 * is disabled, misconfigured, or has no eligible rules for this tenant.
 */
export async function createSocialPublishJobsForArticle(
  tx: Bun.SQL,
  tenantId: string,
  article: PublishedArticleSnapshot,
  trigger: SocialPublishTriggerEvent,
  mediaPort: NewsMediaPort,
  env: NodeJS.ProcessEnv = process.env,
  correlationId?: string
): Promise<CreateSocialPublishJobsResult> {
  if (!isSocialPublishingDeploymentActive(env)) {
    return { jobsCreated: 0, skippedReason: "deployment_disabled" };
  }

  const settings = await fetchSocialPublishingSettings(tx, tenantId);

  if (!settings.autoPublishingEnabled) {
    return { jobsCreated: 0, skippedReason: "tenant_auto_publishing_disabled" };
  }

  const eligibleRules = await listEligibleSocialPublishRulesForTrigger(
    tx,
    tenantId,
    trigger
  );

  if (eligibleRules.length === 0) {
    return { jobsCreated: 0, skippedReason: "no_eligible_rules" };
  }

  const hostname = await resolvePrimaryVerifiedDomainHostname(tx, tenantId);

  if (!hostname) {
    log("warning", "social_publishing.job.skipped_no_canonical_domain", {
      correlationId,
      tenantId,
      moduleKey: MODULE_KEY,
      articleId: article.id
    });

    return { jobsCreated: 0, skippedReason: "no_verified_domain" };
  }

  const canonicalUrl = buildArticleCanonicalUrl(
    hostname,
    article.publicBasePath,
    article.slug
  );

  let imageUrl: string | null = null;

  if (article.featuredMediaId) {
    const resolved = await mediaPort.resolveMediaReferences(tx, tenantId, [
      article.featuredMediaId
    ]);
    imageUrl = resolved.get(article.featuredMediaId)?.publicUrl ?? null;
  }

  let jobsCreated = 0;

  for (const rule of eligibleRules) {
    const captionTemplate = await fetchActiveCaptionTemplate(
      tx,
      tenantId,
      rule.templateId
    );

    const excerptOrCaption = captionTemplate
      ? renderSocialPublishCaption(captionTemplate, {
          title: article.title,
          excerpt: article.excerpt ?? "",
          canonicalUrl
        })
      : (article.excerpt ?? article.title);

    const idempotencyKey = buildSocialPublishIdempotencyKey(
      tenantId,
      article.id,
      rule.socialAccountId,
      rule.providerKey,
      "publish"
    );

    const rows = (await tx`
      INSERT INTO awcms_mini_social_publish_jobs
        (tenant_id, social_account_id, rule_id, article_id, provider_key,
         trigger_event, action, idempotency_key, status, requires_approval,
         title, excerpt_or_caption, canonical_url, image_url, correlation_id)
      VALUES (
        ${tenantId}, ${rule.socialAccountId}, ${rule.ruleId}, ${article.id}, ${rule.providerKey},
        ${trigger}, 'publish', ${idempotencyKey},
        ${rule.requiresApproval ? "requires_approval" : "pending"}, ${rule.requiresApproval},
        ${article.title}, ${excerptOrCaption}, ${canonicalUrl}, ${imageUrl}, ${correlationId ?? null}
      )
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING id
    `) as { id: string }[];

    if (rows.length === 0) {
      // Already enqueued for this (article, account, action) — idempotent no-op.
      continue;
    }

    jobsCreated += 1;

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: MODULE_KEY,
      action: "social_publishing.job.created",
      resourceType: "social_publish_job",
      resourceId: rows[0]!.id,
      severity: "info",
      message: `Social publish job created for provider "${rule.providerKey}" (trigger "${trigger}").`,
      attributes: {
        articleId: article.id,
        socialAccountId: rule.socialAccountId,
        providerKey: rule.providerKey,
        requiresApproval: rule.requiresApproval
      },
      correlationId
    });
  }

  return { jobsCreated };
}
