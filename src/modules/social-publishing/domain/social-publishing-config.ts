/**
 * Full-online-only deployment gate for `social_publishing` (Issue #643).
 * Pure — no `process.env` reads except the default parameter value, same
 * split every other conditional-provider config file in this repo uses
 * (`src/lib/auth/online-security-config.ts`, `email/domain/email-config.ts`,
 * `tenant-domain/domain/tenant-domain-dns-config.ts`).
 *
 * Mirrors `online-security-config.ts`'s exact shape (`*_ENABLED` +
 * `*_PROFILE`, both must agree, default-`false`/`"disabled"` fail-closed) —
 * deliberately NOT a reuse of `NEWS_PORTAL_ENABLED`/`NEWS_PORTAL_PROFILE`
 * (different feature, different deployment decision — a tenant could run
 * full-online news_portal without ever wanting social auto-posting, and
 * vice versa is nonsensical but not this gate's job to prevent) and
 * deliberately NOT a new global `DEPLOYMENT_PROFILE` var (this repo's
 * established convention per `news-portal-preset-readiness.ts` and
 * `online-security-config.ts`'s own header comments: independent
 * per-feature flags, not one central enum).
 *
 * This is the deployment-level ("global") half of the issue's "Auto-posting
 * can be disabled globally and per tenant" requirement — the per-tenant
 * half is `awcms_mini_social_publishing_settings`
 * (`application/social-publishing-settings-directory.ts`), a real DB row an
 * ABAC-gated endpoint can toggle, NOT another env var.
 */
export const KNOWN_SOCIAL_PUBLISHING_PROFILES = [
  "disabled",
  "full_online"
] as const;

export type SocialPublishingProfile =
  (typeof KNOWN_SOCIAL_PUBLISHING_PROFILES)[number];

export function isKnownSocialPublishingProfile(
  value: string | undefined
): value is SocialPublishingProfile {
  return (KNOWN_SOCIAL_PUBLISHING_PROFILES as readonly string[]).includes(
    value ?? ""
  );
}

export function isSocialPublishingEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.SOCIAL_PUBLISHING_ENABLED === "true";
}

/** Falls back to `"disabled"` for unset or unrecognized values — never throws. */
export function resolveSocialPublishingProfile(
  env: NodeJS.ProcessEnv = process.env
): SocialPublishingProfile {
  const raw = env.SOCIAL_PUBLISHING_PROFILE;

  return isKnownSocialPublishingProfile(raw) ? raw : "disabled";
}

/**
 * The single boolean every social-publishing code path (job creation,
 * dispatcher, readiness) gates on. `true` only when BOTH
 * `SOCIAL_PUBLISHING_ENABLED=true` AND `SOCIAL_PUBLISHING_PROFILE=full_online`
 * — an offline/LAN deployment (this pair of vars entirely unset, the
 * default) always gets `false` and never creates a job, never calls a
 * provider, never even reads the `awcms_mini_social_*` tables' business
 * data (the tables still exist — migrations are unconditional — they are
 * simply never populated by application code on such a deployment).
 */
export function isSocialPublishingDeploymentActive(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    isSocialPublishingEnabled(env) &&
    resolveSocialPublishingProfile(env) === "full_online"
  );
}
