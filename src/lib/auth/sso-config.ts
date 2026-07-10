/**
 * Generic tenant OIDC SSO config gate (Issue #591, epic: full-online auth
 * hardening). Mirrors `./google-oidc-config.ts`'s `isGoogleLoginRequired`/
 * `./mfa-config.ts`'s `isMfaRequired`/`../security/turnstile.ts`'s
 * `isTurnstileRequired` shape exactly — `isSsoRequired` is the ONE function
 * every generic-SSO endpoint checks; local/offline/LAN deployments never
 * read these env vars, never fetch OIDC discovery/JWKS, never call any
 * tenant-configured provider.
 *
 * Unlike Google login (Issue #590), the provider's own issuer/client
 * id/secret/scopes/allowed domains are tenant-configured DATA
 * (`awcms_mini_auth_providers`, migration 036), not deployment-wide env
 * vars — this file only owns the three deployment-level knobs from the
 * issue's own §Environment variables: the master enable flag, the at-rest
 * credential encryption key, and the discovery/JWKS fetch timeout.
 */
import { isFullOnlineSecurityActive } from "./online-security-config";

export function isSsoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_SSO_ENABLED === "true";
}

/**
 * The single boolean every generic-SSO endpoint and admin provider/policy
 * endpoint must check before doing anything online/provider-related — true
 * only when BOTH the full-online gate (Issue #587) and this feature's own
 * flag agree. Matches the issue's acceptance criterion "SSO is active only
 * when #587 gate is enabled and AUTH_SSO_ENABLED=true."
 */
export function isSsoRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFullOnlineSecurityActive(env) && isSsoEnabled(env);
}

/**
 * Env vars required only when `AUTH_SSO_ENABLED=true`
 * (`scripts/validate-env.ts`'s `checkSsoConfig`). Only the credential
 * encryption key is deployment-level required — per-provider issuer/client
 * id/secret are tenant-configured DATA (`awcms_mini_auth_providers`), whose
 * presence/validity is checked at provider-create/OAuth-call time, not at
 * deployment boot.
 */
export const SSO_REQUIRED_WHEN_ENABLED = [
  "AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY"
] as const;

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Bounded timeout for OIDC discovery (`.well-known/openid-configuration`)
 * and JWKS fetches (issue's own acceptance criterion: "OIDC discovery and
 * JWKS fetches have bounded timeout"). Falls back to 5000ms for an unset or
 * non-numeric value — never throws, never blocks indefinitely.
 */
export function resolveSsoDiscoveryTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AUTH_SSO_DISCOVERY_TIMEOUT_MS);

  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

const DEFAULT_MAX_PROVIDERS_PER_TENANT = 20;

/**
 * Caps how many active (non-deleted) `awcms_mini_auth_providers` rows a
 * single tenant may hold (Issue #612, follow-up from #610's own
 * security-auditor review). Each provider row gets its own independent
 * `${tenantId}:${providerKey}`-scoped circuit-breaker/negative-cache budget
 * in `generic-oidc-client.ts` — without a cap, a malicious/compromised
 * tenant admin (same threat actor already accepted for #603/#610) could
 * register unbounded provider rows to multiply their total internal-network
 * probing volume linearly. Falls back to 20 for an unset or non-positive
 * value — never throws, never blocks a deployment that doesn't set it.
 */
export function resolveSsoMaxProvidersPerTenant(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AUTH_SSO_MAX_PROVIDERS_PER_TENANT);

  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_PROVIDERS_PER_TENANT;
}

const DEFAULT_REDIRECT_PATH_PREFIX = "/api/v1/auth/sso";

/** Resolves this deployment's own callback redirect URI for a given provider key — always this deployment's own path under `APP_URL`, never client-supplied (open-redirect prevention), same convention as `google-oauth-client.ts`'s `resolveGoogleRedirectUri`. */
export function resolveSsoRedirectUri(
  providerKey: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const appUrl = env.APP_URL ?? "http://localhost:4321";

  return new URL(
    `${DEFAULT_REDIRECT_PATH_PREFIX}/${providerKey}/callback`,
    appUrl
  ).toString();
}
