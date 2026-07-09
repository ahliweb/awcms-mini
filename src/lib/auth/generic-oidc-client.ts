/**
 * Generic tenant OIDC provider network calls (Issue #591, epic: full-online
 * auth hardening) — `.well-known/openid-configuration` discovery, JWKS
 * fetch, and authorization-code token exchange for a TENANT-CONFIGURED
 * issuer (unlike Issue #590's Google login, whose endpoints are hardcoded
 * constants — see `google-oidc-config.ts`'s own comment on why: here the
 * issuer is arbitrary, so discovery is unavoidable).
 *
 * Same timeout + circuit-breaker pattern as `google-oauth-client.ts`/
 * `../security/turnstile.ts`, and the SAME rule PR #596/#598's security
 * reviews forced onto every provider call in this epic: the circuit
 * breaker only trips on a genuine transport-level failure (non-2xx the
 * caller didn't cause, network error, timeout), NEVER on a well-formed
 * error response driven by attacker-controlled input (a bad/reused/expired
 * authorization `code` answered with `400 invalid_grant` is the provider
 * correctly rejecting a bad request, not the provider being unhealthy).
 * Breakers are keyed PER PROVIDER (`sso-oidc-discovery:<providerKey>` etc.)
 * — a slow/unhealthy tenant-configured provider must never affect any
 * other tenant's or provider's login, unlike the single application-wide
 * database circuit breaker.
 *
 * SSRF note (Issue #603, decided — not an oversight): `issuer_url` (and
 * whatever `token_endpoint`/`jwks_uri` its discovery document points to)
 * is the one outbound URL in this codebase that comes from tenant-admin
 * data rather than server env config, unlike every other provider adapter
 * (R2, Mailketing, Cloudflare). Deliberately NOT IP-range-blocked: AWCMS-Mini
 * supports LAN-first/offline deployments where a tenant's OIDC provider
 * (on-prem Keycloak/ADFS) legitimately runs on a private IP — blocking
 * private ranges would break that deployment model, not just attackers.
 * Mitigated by ABAC on provider CRUD + audit logging, matching how Okta/
 * Auth0/Azure AD themselves handle admin-configured issuer URLs. See skill
 * `awcms-mini-auth-online-hardening` §SSRF/`issuer_url` for the full
 * rationale before reopening this as a "gap."
 */
import { getProviderCircuitBreaker } from "../database/circuit-breaker";
import { withTimeout } from "../integration/timeout";
import { resolveSsoDiscoveryTimeoutMs } from "./sso-config";

export type OidcDiscoveryDocument = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type DiscoverOidcResult =
  { ok: true; document: OidcDiscoveryDocument } | { ok: false };

const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;

const discoveryCache = new Map<
  string,
  { document: OidcDiscoveryDocument; fetchedAt: number }
>();

function normalizeIssuerUrl(issuerUrl: string): string {
  return issuerUrl.endsWith("/") ? issuerUrl.slice(0, -1) : issuerUrl;
}

/**
 * Fetches (and caches for `DISCOVERY_CACHE_TTL_MS`, same rationale as
 * `google-oauth-client.ts`'s JWKS cache — a provider's discovery document
 * changes rarely) a tenant-configured provider's
 * `.well-known/openid-configuration`. `providerKey` scopes the circuit
 * breaker AND the cache key so one misconfigured/unhealthy tenant provider
 * never affects another tenant's identically-issued provider (e.g. two
 * tenants both pointing at the same Okta org).
 */
export async function discoverOidcConfiguration(
  providerKey: string,
  issuerUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<DiscoverOidcResult> {
  const normalizedIssuer = normalizeIssuerUrl(issuerUrl);
  const cached = discoveryCache.get(providerKey);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return { ok: true, document: cached.document };
  }

  const breaker = getProviderCircuitBreaker(
    `sso-oidc-discovery:${providerKey}`
  );
  const attemptedAt = new Date();

  if (!breaker.canAttempt(attemptedAt)) {
    return { ok: false };
  }

  try {
    const response = await withTimeout(
      fetch(`${normalizedIssuer}/.well-known/openid-configuration`),
      resolveSsoDiscoveryTimeoutMs(env),
      `oidc discovery (${providerKey})`
    );

    if (response.status < 200 || response.status >= 300) {
      breaker.recordFailure(attemptedAt);
      return { ok: false };
    }

    const document = (await response
      .json()
      .catch(() => null)) as Partial<OidcDiscoveryDocument> | null;

    if (
      !document ||
      typeof document.authorization_endpoint !== "string" ||
      typeof document.token_endpoint !== "string" ||
      typeof document.jwks_uri !== "string" ||
      typeof document.issuer !== "string"
    ) {
      breaker.recordFailure(attemptedAt);
      return { ok: false };
    }

    breaker.recordSuccess(attemptedAt);
    const resolved = document as OidcDiscoveryDocument;
    discoveryCache.set(providerKey, { document: resolved, fetchedAt: now });
    return { ok: true, document: resolved };
  } catch {
    breaker.recordFailure(attemptedAt);
    return { ok: false };
  }
}

export type GenericJwks = { keys: Record<string, unknown>[] };

const jwksCache = new Map<string, { jwks: GenericJwks; fetchedAt: number }>();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

export type FetchJwksResult = { ok: true; jwks: GenericJwks } | { ok: false };

/** Same breaker-tripping rule as `discoverOidcConfiguration`/`exchangeAuthorizationCode` — only a genuine transport failure counts. */
export async function fetchProviderJwks(
  providerKey: string,
  jwksUri: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<FetchJwksResult> {
  const cached = jwksCache.get(providerKey);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return { ok: true, jwks: cached.jwks };
  }

  const breaker = getProviderCircuitBreaker(`sso-oidc-jwks:${providerKey}`);
  const attemptedAt = new Date();

  if (!breaker.canAttempt(attemptedAt)) {
    return { ok: false };
  }

  try {
    const response = await withTimeout(
      fetch(jwksUri),
      resolveSsoDiscoveryTimeoutMs(env),
      `oidc jwks fetch (${providerKey})`
    );

    if (response.status < 200 || response.status >= 300) {
      breaker.recordFailure(attemptedAt);
      return { ok: false };
    }

    const jwks = (await response
      .json()
      .catch(() => null)) as GenericJwks | null;

    if (!jwks || !Array.isArray(jwks.keys)) {
      breaker.recordFailure(attemptedAt);
      return { ok: false };
    }

    breaker.recordSuccess(attemptedAt);
    jwksCache.set(providerKey, { jwks, fetchedAt: now });
    return { ok: true, jwks };
  } catch {
    breaker.recordFailure(attemptedAt);
    return { ok: false };
  }
}

export type ExchangeCodeParams = {
  providerKey: string;
  tokenEndpoint: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  timeoutMs?: number;
};

export type ExchangeCodeResult =
  { ok: true; idToken: string } | { ok: false; retryable: boolean };

/**
 * Authorization Code exchange against a tenant-configured provider's own
 * `token_endpoint` (resolved via `discoverOidcConfiguration`). Mirrors
 * `google-oauth-client.ts`'s `exchangeAuthorizationCode` exactly, including
 * its breaker-tripping rule: a genuine 5xx/network/timeout records failure;
 * a well-formed 4xx (bad/reused/expired `code`) records SUCCESS (the
 * provider is healthy — it just correctly rejected attacker-controlled
 * input) and returns a non-retryable failure.
 */
export async function exchangeAuthorizationCode(
  params: ExchangeCodeParams
): Promise<ExchangeCodeResult> {
  const breaker = getProviderCircuitBreaker(
    `sso-oidc-token:${params.providerKey}`
  );
  const attemptedAt = new Date();

  if (!breaker.canAttempt(attemptedAt)) {
    return { ok: false, retryable: true };
  }

  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code"
  });

  try {
    const response = await withTimeout(
      fetch(params.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }),
      params.timeoutMs ?? resolveSsoDiscoveryTimeoutMs(),
      `oidc token exchange (${params.providerKey})`
    );

    const rawBody = await response.text().catch(() => "");
    let parsed: { id_token?: string } | undefined;

    try {
      parsed = rawBody
        ? (JSON.parse(rawBody) as { id_token?: string })
        : undefined;
    } catch {
      parsed = undefined;
    }

    if (response.status >= 500 || response.status === 0 || !parsed) {
      breaker.recordFailure(attemptedAt);
      return { ok: false, retryable: true };
    }

    if (response.status < 200 || response.status >= 300 || !parsed.id_token) {
      breaker.recordSuccess(attemptedAt);
      return { ok: false, retryable: false };
    }

    breaker.recordSuccess(attemptedAt);
    return { ok: true, idToken: parsed.id_token };
  } catch {
    breaker.recordFailure(attemptedAt);
    return { ok: false, retryable: true };
  }
}

/** Test-only: clears the in-memory discovery/JWKS caches so test files don't bleed into each other. */
export function resetGenericOidcCachesForTests(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
