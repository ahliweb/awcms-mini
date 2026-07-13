/**
 * LinkedIn organization-page provider config gate (Issue #645, epic
 * `social_publishing` #643-#647). Pure — no `process.env` reads except the
 * default parameter value, same split every other conditional-provider
 * config file in this repo uses (`src/lib/auth/google-oidc-config.ts`,
 * `email/domain/email-config.ts`, `news-portal/domain/news-media-r2-config.ts`).
 *
 * `LINKEDIN_PROVIDER_ENABLED` is a THIRD, independent flag layered on top of
 * the two existing social-publishing gates
 * (`SOCIAL_PUBLISHING_ENABLED`/`SOCIAL_PUBLISHING_PROFILE`,
 * `social-publishing-config.ts`) — a deployment can run the social
 * publishing outbox/dispatcher for Meta/Telegram while never wanting the
 * LinkedIn adapter registered at all. Mirrors
 * `AUTH_GOOGLE_LOGIN_ENABLED`'s "per-provider toggle layered on a broader
 * feature gate" shape exactly.
 *
 * ## Why `LINKEDIN_OAUTH_REDIRECT_URI`/`LINKEDIN_CLIENT_ID`/
 * `LINKEDIN_CLIENT_SECRET_REFERENCE` are validated but never used to drive
 * an interactive OAuth redirect in this codebase
 *
 * Unlike `google-oauth-client.ts` (a REAL 3-legged authorization-code
 * exchange this repo implements end-to-end, including a `/callback`
 * route), this issue deliberately does NOT build a LinkedIn OAuth
 * authorize/callback flow. Two reasons, not one:
 *
 * 1. `awcms_mini_social_accounts.token_reference` (Issue #643) must NEVER
 *    hold a raw access token — `social-account-validation.ts`'s
 *    `looksLikeRawSecretToken` actively rejects values shaped like one at
 *    write time. A real OAuth code-exchange callback would receive a
 *    genuine raw LinkedIn access token straight from LinkedIn's token
 *    endpoint; without a real secret-manager integration (a documented
 *    residual across this whole epic, see
 *    `.claude/skills/awcms-mini-social-publishing/SKILL.md` §643 Keputusan
 *    kunci #3) there is nowhere safe to put that raw token that satisfies
 *    the "reference, not a real token" invariant.
 * 2. The foundation's own connect flow
 *    (`POST /api/v1/social-publishing/accounts`) is already
 *    provider-neutral and manual/operator-driven for every provider — an
 *    operator obtains a token (or a reference to one) OUTSIDE this app and
 *    pastes it in. LinkedIn is not special-cased here.
 *
 * `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET_REFERENCE`/
 * `LINKEDIN_OAUTH_REDIRECT_URI` are still real, required configuration —
 * they describe the LinkedIn App an operator must register in LinkedIn's
 * Developer portal (app review, redirect URI allow-list, requested
 * scopes) to obtain that externally-issued token in the first place, and
 * `LINKEDIN_REQUIRED_SCOPES`/`verifyCredentials` (`linkedin-provider-adapter.ts`)
 * check that whatever was obtained actually carries the scopes this
 * adapter needs. Readiness (`security:readiness`) fails loudly if any of
 * them is missing while `LINKEDIN_PROVIDER_ENABLED=true` — this is
 * deliberately a STATIC config-completeness check only (no live network
 * call), matching every other provider readiness check in this repo
 * (`checkGoogleOidcReady`, `checkEmailProviderConfigReady`) — live
 * token/role/scope verification is `verifyCredentials`'s job (an
 * adapter-level, per-account check, not a deployment-wide one).
 */
import { looksLikeRawSecretToken } from "./social-account-validation";

/**
 * LinkedIn's real `organizationAcl` roles that this adapter treats as
 * eligible to create organization posts. `ADMINISTRATOR` and
 * `CONTENT_ADMIN` can manage/post as the organization page;
 * `DIRECT_SPONSORED_CONTENT_POSTER` only grants sponsored/ads posting
 * (explicitly out of scope per this issue's "Out of scope: sponsored
 * posts/campaign management") and is deliberately NOT included here even
 * though LinkedIn itself considers it a valid organizationAcl role —
 * accepting it here would let an ads-only credential silently attempt an
 * organic post it's not actually meant for.
 */
export const LINKEDIN_SUPPORTED_ORGANIZATION_ROLES = [
  "ADMINISTRATOR",
  "CONTENT_ADMIN"
] as const;

export type LinkedInOrganizationRole =
  (typeof LINKEDIN_SUPPORTED_ORGANIZATION_ROLES)[number];

export function isSupportedLinkedInOrganizationRole(
  role: string
): role is LinkedInOrganizationRole {
  return (LINKEDIN_SUPPORTED_ORGANIZATION_ROLES as readonly string[]).includes(
    role
  );
}

/** Real LinkedIn REST API host — overridable ONLY for tests/dev via `LinkedInProviderAdapterConfig.apiBaseUrl` (`linkedin-provider-adapter.ts`), never by an env var an operator could point at an unintended host in production (same convention `mailketing-provider.ts`'s `DEFAULT_BASE_URL`/`baseUrl` override uses). */
export const LINKEDIN_DEFAULT_API_BASE_URL = "https://api.linkedin.com";

/** Per-call timeout for a single outbound LinkedIn HTTP request — deliberately below the dispatcher's own outer `SOCIAL_PUBLISH_CALL_TIMEOUT_MS` (10s, `social-publish-dispatch.ts`) so THIS adapter's own timeout fires first and produces a clean, attributable `TimeoutError` rather than relying solely on the caller's outer race (interface doc comment on `SocialProviderAdapter.publish`: "a well-behaved adapter should not rely solely on the caller's outer timeout"). `publish()` makes up to two sequential calls (role check, then post) — 4s each keeps the worst case comfortably under the 10s outer bound. */
export const LINKEDIN_DEFAULT_CALL_TIMEOUT_MS = 4_000;

/** `X-Restli-Protocol-Version` — fixed at LinkedIn's current (and, per their docs, only supported) Rest.li protocol version. Not configurable — this is a wire-protocol version, not an API-surface version (that's `LINKEDIN_API_VERSION`/`LinkedIn-Version`). */
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = "2.0.0";

/** `LINKEDIN_API_VERSION` must look like a LinkedIn versioned-API release string (`YYYYMM`, e.g. `"202506"`) — the exact value LinkedIn documents for its `LinkedIn-Version` header. */
const LINKEDIN_API_VERSION_PATTERN = /^\d{6}$/;

export function isValidLinkedInApiVersion(value: string): boolean {
  return LINKEDIN_API_VERSION_PATTERN.test(value);
}

/** Env vars required only when `LINKEDIN_PROVIDER_ENABLED=true` (`scripts/validate-env.ts`'s `checkLinkedInProviderConfig`, `scripts/security-readiness.ts`'s `checkLinkedInProviderReadiness`). */
export const LINKEDIN_REQUIRED_WHEN_ENABLED = [
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET_REFERENCE",
  "LINKEDIN_API_VERSION",
  "LINKEDIN_OAUTH_REDIRECT_URI",
  "LINKEDIN_REQUIRED_SCOPES"
] as const;

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isLinkedInProviderEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.LINKEDIN_PROVIDER_ENABLED === "true";
}

export function resolveLinkedInApiVersion(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.LINKEDIN_API_VERSION?.trim() ?? "";
}

/** Comma-separated, trimmed, empty entries dropped. Empty result means every scope check fails closed (no scope is ever treated as "satisfied" for an unset list). */
export function resolveLinkedInRequiredScopes(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const raw = env.LINKEDIN_REQUIRED_SCOPES;

  if (!isSet(raw)) {
    return [];
  }

  return (raw as string)
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Config keys missing/empty when `LINKEDIN_PROVIDER_ENABLED=true`, PLUS two
 * dedicated, differently-labeled checks:
 *
 * - `LINKEDIN_API_VERSION`'s FORMAT (present but malformed is a distinct
 *   failure mode from absent — both are real misconfigurations, but "you
 *   typed the version wrong" deserves a clearer message than "missing").
 * - `LINKEDIN_CLIENT_SECRET_REFERENCE`'s SHAPE, via
 *   `looksLikeRawSecretToken` directly (Medium finding, PR #737 review):
 *   this reference is never resolved by any live call in this adapter
 *   today (only an account's own `token_reference` is, via
 *   `resolveLinkedInSecretReference`), so nothing else in this codebase
 *   was actually enforcing the "never a raw secret" claim this variable's
 *   own doc 18/registry description makes — an operator who pastes a real
 *   client secret here by mistake would have sailed through both
 *   `config:validate` and `security:readiness` silently. Checked directly
 *   here (not via `resolveLinkedInSecretReference`, which additionally
 *   requires an `env:`-resolvable value — this variable is validated for
 *   SHAPE only, not resolved).
 *
 * Empty array when disabled or fully configured.
 */
export function findMissingOrInvalidLinkedInConfig(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (!isLinkedInProviderEnabled(env)) {
    return [];
  }

  const problems = LINKEDIN_REQUIRED_WHEN_ENABLED.filter(
    (name) => !isSet(env[name])
  ) as string[];

  const apiVersion = resolveLinkedInApiVersion(env);

  if (isSet(apiVersion) && !isValidLinkedInApiVersion(apiVersion)) {
    problems.push('LINKEDIN_API_VERSION (must match "YYYYMM", e.g. "202506")');
  }

  const clientSecretReference = env.LINKEDIN_CLIENT_SECRET_REFERENCE;

  if (
    isSet(clientSecretReference) &&
    looksLikeRawSecretToken(clientSecretReference as string)
  ) {
    problems.push(
      "LINKEDIN_CLIENT_SECRET_REFERENCE (looks like a raw secret/JWT, not a secret-storage reference)"
    );
  }

  return problems;
}

export type ResolvedLinkedInSecretReference =
  | { ok: true; value: string }
  | { ok: false; reason: "unset" | "looks_like_raw_secret" | "unresolvable" };

/**
 * Resolves a "reference" string (`LINKEDIN_CLIENT_SECRET_REFERENCE`, or an
 * account's own `token_reference` passed in by the dispatcher) to the real
 * secret value. Reuses `social-account-validation.ts`'s
 * `looksLikeRawSecretToken` VERBATIM (per this issue's own security notes —
 * do not invent a parallel heuristic) to refuse resolving anything that is
 * itself shaped like a raw secret rather than a reference — the check runs
 * ONLY against the caller-supplied REFERENCE string (before resolving),
 * never against the value it resolves TO.
 *
 * ## Round 1 security-auditor finding (PR #737) — read before touching this
 * function again
 *
 * An earlier version re-applied `looksLikeRawSecretToken` to the RESOLVED
 * value too (`isSet(resolved) && !looksLikeRawSecretToken(resolved)`). That
 * is wrong, not merely redundant: the whole point of resolving a reference
 * is to get back a real secret, and a real LinkedIn OAuth2 access token
 * (typically 150-1000+ opaque characters) is EXACTLY the shape
 * `looksLikeRawSecretToken`'s 64+-char high-entropy catch-all is designed
 * to flag. That earlier version therefore rejected every realistic
 * resolution as `"unresolvable"`, meaning `publish()`/`verifyCredentials()`
 * could never succeed for any correctly-configured real account — only
 * the test suite's short (~35 char) fake token happened to dodge the
 * 64-char threshold, hiding the bug. Fixed by validating shape ONLY on the
 * untrusted, caller-supplied reference string; once a value has been
 * resolved from a NAMED, OPERATOR-CONFIGURED env var via the recognized
 * `env:` convention, it is trusted by construction (same reasoning
 * `resolveMetaTokenReference`, the sibling Meta adapter, already applies —
 * it only checks the reference is `env:`-shaped and the resolved value is
 * non-empty).
 *
 * Only the `env:VAR_NAME` reference convention is actually resolvable in
 * this repo today — no real secret-manager integration exists (documented
 * residual, see `.claude/skills/awcms-mini-social-publishing/SKILL.md`
 * §643 Keputusan kunci #3). Any other recognized-prefix reference
 * (`secretsmanager:`/`vault:`/`ssm:`/`kms:`/`ref:`) is syntactically
 * accepted by `looksLikeRawSecretToken`'s allow-list but reported
 * `"unresolvable"` here — honest about what this codebase can actually do,
 * never silently treats an unresolvable reference as the literal string.
 */
export function resolveLinkedInSecretReference(
  reference: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedLinkedInSecretReference {
  if (!isSet(reference ?? undefined)) {
    return { ok: false, reason: "unset" };
  }

  const value = (reference as string).trim();

  if (looksLikeRawSecretToken(value)) {
    return { ok: false, reason: "looks_like_raw_secret" };
  }

  const envPrefixMatch = value.match(/^env:(.+)$/i);

  if (envPrefixMatch) {
    const varName = envPrefixMatch[1]!.trim();
    const resolved = env[varName];

    if (isSet(resolved)) {
      return { ok: true, value: (resolved as string).trim() };
    }

    // The named env var is unset — not a usable resolution.
    return { ok: false, reason: "unresolvable" };
  }

  return { ok: false, reason: "unresolvable" };
}
