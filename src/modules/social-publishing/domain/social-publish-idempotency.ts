import { createHash } from "node:crypto";

/**
 * Deterministic idempotency key for `awcms_mini_social_publish_jobs`
 * (Issue #643 acceptance criterion: "Jobs are idempotent per
 * article/platform/account"). Same stable-hash approach
 * `_shared/idempotency.ts`'s `computeRequestHash` uses for HTTP mutation
 * idempotency, applied here to a narrower, fully-deterministic tuple so the
 * SAME `(tenantId, articleId, socialAccountId, action)` combination always
 * produces the SAME key — this is what makes
 * `create-social-publish-jobs.ts`'s `INSERT ... ON CONFLICT
 * (tenant_id, idempotency_key) DO NOTHING` idempotent even across repeated
 * publish-event deliveries (e.g. the scheduled-publish worker re-running
 * after a crash, or an editor re-triggering a manual action).
 *
 * `providerKey`/`socialAccountId` are combined (not just `socialAccountId`
 * alone) purely for defense-in-depth readability in the hashed input —
 * `socialAccountId` alone is already unique per provider (see
 * `awcms_mini_social_accounts_identity_key`), so this does not change the
 * uniqueness guarantee, only what a debugger sees if they ever need to
 * recompute a key by hand.
 */
export function buildSocialPublishIdempotencyKey(
  tenantId: string,
  articleId: string,
  socialAccountId: string,
  providerKey: string,
  action: string
): string {
  const input = [
    tenantId,
    articleId,
    socialAccountId,
    providerKey,
    action
  ].join(":");

  return createHash("sha256").update(input).digest("hex");
}
