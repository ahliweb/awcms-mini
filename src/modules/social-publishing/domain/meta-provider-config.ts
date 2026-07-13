/**
 * Meta (Facebook Page + Instagram Business) adapter config (Issue #644,
 * epic `social_publishing` #643-#647). Pure — no `process.env` reads
 * except the default parameter value, same split every other conditional-
 * provider config file in this repo uses (`social-publishing-config.ts`,
 * `email/domain/email-config.ts`).
 *
 * `META_PROVIDER_ENABLED` is a SECOND, adapter-level gate — independent of
 * `SOCIAL_PUBLISHING_ENABLED`/`SOCIAL_PUBLISHING_PROFILE` (the deployment-
 * wide master switch checked upstream in `create-social-publish-jobs.ts`).
 * A deployment can have social publishing enabled in general while Meta
 * specifically stays unconfigured (e.g. only Telegram is set up) — in that
 * case `loadMetaProviderConfig` returns `null` and the adapter's own
 * `publish`/`verifyCredentials` return a normalized `failed`/`invalid`
 * outcome (`meta_provider_not_configured`) rather than throwing, so
 * registering this adapter unconditionally at process start (see
 * `infrastructure/social-provider-registry.ts`'s trailing registration
 * block) can never crash a deployment that doesn't use Meta at all.
 */
export type MetaProviderConfig = {
  appId: string;
  /**
   * Opaque reference into external secret storage — NEVER the raw app
   * secret. Resolved to a real value the SAME way an account's
   * `token_reference` is (`meta-token-reference-resolver.ts`'s
   * `resolveMetaTokenReference`), not read directly as a credential here.
   */
  appSecretReference: string;
  /** e.g. `"v21.0"` — validated shape only, never assumed to be the latest/supported version by Meta today (an operator's responsibility to keep current). */
  graphApiVersion: string;
  oauthRedirectUri: string;
  /** Non-empty, deduplicated, trimmed. */
  requiredScopes: string[];
};

const GRAPH_API_VERSION_PATTERN = /^v\d{1,2}\.\d{1,2}$/;

export function isMetaProviderEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.META_PROVIDER_ENABLED === "true";
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRequiredScopes(raw: string): string[] {
  const scopes = raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  return Array.from(new Set(scopes));
}

/**
 * `null` whenever Meta isn't enabled OR any required variable is missing/
 * malformed — every caller (both adapters, the config/readiness checks)
 * treats `null` as "cannot use Meta right now," never throws. Mirrors
 * `resolveSocialPublishingProfile`'s "never throws, fails closed to an
 * inert value" convention.
 */
export function loadMetaProviderConfig(
  env: NodeJS.ProcessEnv = process.env
): MetaProviderConfig | null {
  if (!isMetaProviderEnabled(env)) {
    return null;
  }

  const appId = env.META_APP_ID;
  const appSecretReference = env.META_APP_SECRET_REFERENCE;
  const graphApiVersion = env.META_GRAPH_API_VERSION;
  const oauthRedirectUri = env.META_OAUTH_REDIRECT_URI;
  const requiredScopesRaw = env.META_REQUIRED_SCOPES;

  if (
    !isNonEmpty(appId) ||
    !isNonEmpty(appSecretReference) ||
    !isNonEmpty(graphApiVersion) ||
    !isNonEmpty(oauthRedirectUri) ||
    !isNonEmpty(requiredScopesRaw)
  ) {
    return null;
  }

  if (!GRAPH_API_VERSION_PATTERN.test(graphApiVersion)) {
    return null;
  }

  let redirectUrl: URL;

  try {
    redirectUrl = new URL(oauthRedirectUri);
  } catch {
    return null;
  }

  if (redirectUrl.protocol !== "https:") {
    return null;
  }

  const requiredScopes = parseRequiredScopes(requiredScopesRaw);

  if (requiredScopes.length === 0) {
    return null;
  }

  return {
    appId,
    appSecretReference,
    graphApiVersion,
    oauthRedirectUri,
    requiredScopes
  };
}
