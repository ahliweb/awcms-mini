/**
 * `NEWS_SHARE_*` configuration gate (Issue #642, epic `news_portal`
 * #631-#642/#649 — "public social share buttons for news articles"). Pure —
 * no `process.env` reads except the default parameter value, same split as
 * `news-media-r2-config.ts` and `src/lib/auth/mfa-config.ts`
 * (`env: NodeJS.ProcessEnv = process.env`).
 *
 * ## Scope — UI/rendering config only, no new persisted data
 *
 * Every var here is a simple boolean feature flag gating whether a given
 * share platform's button/link is rendered on a public `/news`/
 * `/blog/{tenantCode}` article page — there is no per-tenant override table
 * (unlike, say, `blog_content`'s `publicRouteMode` module setting). This
 * matches the issue body's own "Suggested settings" list, which is
 * env-var-shaped (`NEWS_SHARE_BUTTONS_ENABLED=true`, ALL_CAPS `=true/false`)
 * — the same convention every other global feature flag in this repo uses
 * (`NEWS_PORTAL_ENABLED`, `VISITOR_ANALYTICS_ENABLED`, `R2_ENABLED`), not a
 * tenant-scoped DB setting. Deliberately does NOT invent a
 * `NEWS_SHARE_COPY_LINK_ENABLED` var — the issue's own suggested list has no
 * such entry; copy-link is the universal fallback whenever the master
 * switch (`NEWS_SHARE_BUTTONS_ENABLED`) is on, gated by nothing else.
 *
 * ## Default `true`, not `false` — a deliberate deviation from this
 * repo's usual "opt-in, default off" convention for new feature flags
 *
 * Every other recently-added master switch in this codebase
 * (`NEWS_PORTAL_ENABLED`, `NEWS_MEDIA_R2_ENABLED`, `VISITOR_ANALYTICS_ENABLED`,
 * `AUTH_MFA_ENABLED`, ...) defaults `false` because enabling it turns on
 * either a new data-collection surface (visitor analytics), a new
 * credential-bearing external integration (R2), or a new auth code path
 * that needs operator-supplied secrets first (MFA/SSO). Share buttons have
 * none of those properties: no data is collected, no third-party script is
 * loaded, no secret needs provisioning — every link is a same-origin
 * `<a href>`/`<button>` built entirely from data the page already renders
 * publicly (title/excerpt/canonical URL). Defaulting to `true` matches the
 * issue's own "Suggested settings" block verbatim and the ordinary
 * expectation that a public news site ships with working share buttons out
 * of the box; operators who need to disable a specific platform (regulatory,
 * editorial policy) still can, per-flag.
 *
 * `NEWS_SHARE_INSTAGRAM_NATIVE_ONLY` does not gate a dedicated "Instagram"
 * button at all (there is no supported Instagram web-share intent URL — see
 * the architecture note in `social-share-links.ts`) — it only toggles a
 * short, non-interactive accessibility note next to the native-share button
 * clarifying that Instagram sharing goes through the OS share sheet (native
 * share) or copy-link, never a fake Instagram URL.
 */

export type NewsShareConfig = {
  buttonsEnabled: boolean;
  native: boolean;
  whatsapp: boolean;
  telegram: boolean;
  facebook: boolean;
  linkedin: boolean;
  x: boolean;
  email: boolean;
  instagramNativeOnly: boolean;
};

function readBooleanFlag(
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value === "true";
}

export function resolveNewsShareConfig(
  env: NodeJS.ProcessEnv = process.env
): NewsShareConfig {
  return {
    buttonsEnabled: readBooleanFlag(env.NEWS_SHARE_BUTTONS_ENABLED, true),
    native: readBooleanFlag(env.NEWS_SHARE_NATIVE_ENABLED, true),
    whatsapp: readBooleanFlag(env.NEWS_SHARE_WHATSAPP_ENABLED, true),
    telegram: readBooleanFlag(env.NEWS_SHARE_TELEGRAM_ENABLED, true),
    facebook: readBooleanFlag(env.NEWS_SHARE_FACEBOOK_ENABLED, true),
    linkedin: readBooleanFlag(env.NEWS_SHARE_LINKEDIN_ENABLED, true),
    x: readBooleanFlag(env.NEWS_SHARE_X_ENABLED, true),
    email: readBooleanFlag(env.NEWS_SHARE_EMAIL_ENABLED, true),
    instagramNativeOnly: readBooleanFlag(
      env.NEWS_SHARE_INSTAGRAM_NATIVE_ONLY,
      true
    )
  };
}
