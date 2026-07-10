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
 *
 * Breakers AND caches are keyed by `${tenantId}:${providerKey}` — NEVER
 * `providerKey` alone (fixed by Issue #610's own security-auditor review,
 * a real bug this file shipped with from #591 until then). `provider_key`
 * is only unique PER TENANT (`awcms_mini_auth_providers`'s unique index is
 * `(tenant_id, provider_key)`, migration 036) — two different tenants can
 * and commonly do both name a provider `"okta"`. Keying by `providerKey`
 * alone meant tenant A's cached discovery document (or circuit-breaker
 * state) for `"okta"` would be served to tenant B's `"okta"` lookup too —
 * not just a cross-tenant availability leak, but a full cross-tenant
 * takeover primitive: a malicious tenant admin (already has ABAC
 * `sso_providers.create` in their OWN tenant, the same privilege level
 * already accepted as a threat actor in Issue #603/#610) could register a
 * provider named after a common vendor slug with `issuer_url` pointing at
 * an attacker-controlled server, trigger one discovery fetch, and have
 * that attacker-controlled `authorization_endpoint`/`token_endpoint`/
 * `jwks_uri` served to ANY OTHER tenant's identically-named, legitimately
 * configured provider — redirecting victims' SSO login to a phishing page
 * and/or letting the attacker forge ID tokens their own JWKS would
 * "correctly" verify. Every call site below now takes `tenantId` and
 * includes it in every cache/breaker key.
 *
 * SSRF note (Issue #603, decided — not an oversight): `issuer_url` (and
 * whatever `token_endpoint`/`jwks_uri` its discovery document points to)
 * is the one outbound URL in this codebase that comes from tenant-admin
 * data rather than server env config, unlike every other provider adapter
 * (R2, Mailketing, Cloudflare). Deliberately NOT IP-range-blocked: this
 * generic SSO feature only activates in the `full_online` deployment
 * profile (`isFullOnlineSecurityActive`), which still often needs to
 * reach an enterprise tenant's on-prem IdP over a private VPN/tunnel path
 * — blocking private ranges would break that legitimate pattern.
 *
 * IMPORTANT — this is NOT fully mitigated by ABAC: the gate on
 * `identity_access.sso_providers.create`/`update` only limits who can
 * CONFIGURE a malicious `issuer_url`, not who can TRIGGER the fetch
 * afterward — `GET /api/v1/auth/sso/{providerKey}/start` (the entry
 * point into this file's functions) is unauthenticated. Issue #610
 * (follow-up from #603) narrows, but does not eliminate, the residual
 * probing surface this creates: the negative-TTL caches below
 * (`discoveryFailureCache`/`jwksFailureCache`) mean a target that never
 * returns a valid document stops getting a fresh live network attempt on
 * every single hit — repeated probes within the negative-TTL window get
 * an instant cached failure instead, and once the (now correctly
 * tenant+provider-scoped) circuit breaker opens after
 * `DEFAULT_PROVIDER_FAILURE_THRESHOLD` consecutive failures, it fails
 * fast for 30s regardless of how many source IPs a prober rotates
 * through. Deliberately NOT paired with an aggregate/shared HTTP-level
 * rate limit on `/start` itself — an earlier draft of #610 added one
 * keyed by `${tenantId}:${providerKey}` covering ALL requests (not just
 * failures), which the same security-auditor review found was itself a
 * trivial, privilege-free DoS: anyone, from as few as 3 source IPs, could
 * exhaust that SHARED budget and lock out every legitimate user of that
 * tenant's SSO login for the whole window, repeatedly. The breaker/cache
 * combo above only ever throttles FAILING attempts, so it can never
 * block a legitimate login to a healthy provider — that asymmetry is the
 * point. Real internal-network reconnaissance is still possible within
 * these bounds, just meaningfully throttled rather than "no real
 * throttling." See skill `awcms-mini-auth-online-hardening`
 * §SSRF/`issuer_url` for the full, audit-corrected rationale before
 * reopening this as a "gap" or assuming ABAC alone closes it.
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

/**
 * Short negative-TTL for a FAILED discovery/JWKS attempt (Issue #610,
 * follow-up from the Issue #603 SSRF risk-acceptance decision). The
 * positive cache above only ever fills on success, so before this existed
 * a target that never returns a valid OIDC document got a fresh live
 * network attempt on every single unauthenticated `/start` hit — this
 * cache makes repeated hits within the window return the same cached
 * failure instantly instead, removing most of the timing/liveness signal
 * an internal-network prober could otherwise read from repeated probes.
 * Deliberately much shorter than the positive TTL: a real provider
 * recovering from a transient outage should start working again quickly
 * once its own health is restored, not stay cached-failed for an hour.
 */
const NEGATIVE_CACHE_TTL_MS = 30 * 1000;

const discoveryCache = new Map<
  string,
  { document: OidcDiscoveryDocument; fetchedAt: number }
>();
const discoveryFailureCache = new Map<string, number>();

function normalizeIssuerUrl(issuerUrl: string): string {
  return issuerUrl.endsWith("/") ? issuerUrl.slice(0, -1) : issuerUrl;
}

/** `provider_key` is only unique PER TENANT — this is the ONE cache/breaker
 * key builder every function below must use, so a future call site can't
 * reintroduce the cross-tenant bug this file shipped with pre-#610. */
function scopedProviderKey(tenantId: string, providerKey: string): string {
  return `${tenantId}:${providerKey}`;
}

/**
 * Fetches (and caches for `DISCOVERY_CACHE_TTL_MS`, same rationale as
 * `google-oauth-client.ts`'s JWKS cache — a provider's discovery document
 * changes rarely) a tenant-configured provider's
 * `.well-known/openid-configuration`. Cache/breaker key is
 * `${tenantId}:${providerKey}` (see `scopedProviderKey` and this file's own
 * top comment) so one misconfigured/unhealthy/malicious tenant provider
 * never affects another tenant's identically-NAMED provider.
 */
export async function discoverOidcConfiguration(
  tenantId: string,
  providerKey: string,
  issuerUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<DiscoverOidcResult> {
  const key = scopedProviderKey(tenantId, providerKey);
  const normalizedIssuer = normalizeIssuerUrl(issuerUrl);
  const cached = discoveryCache.get(key);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return { ok: true, document: cached.document };
  }

  const recentFailure = discoveryFailureCache.get(key);

  if (
    recentFailure !== undefined &&
    now - recentFailure < NEGATIVE_CACHE_TTL_MS
  ) {
    return { ok: false };
  }

  const breaker = getProviderCircuitBreaker(`sso-oidc-discovery:${key}`);
  const attemptedAt = new Date();

  if (!breaker.canAttempt(attemptedAt)) {
    discoveryFailureCache.set(key, now);
    return { ok: false };
  }

  try {
    const response = await withTimeout(
      fetch(`${normalizedIssuer}/.well-known/openid-configuration`),
      resolveSsoDiscoveryTimeoutMs(env),
      `oidc discovery (${key})`
    );

    if (response.status < 200 || response.status >= 300) {
      breaker.recordFailure(attemptedAt);
      discoveryFailureCache.set(key, now);
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
      discoveryFailureCache.set(key, now);
      return { ok: false };
    }

    breaker.recordSuccess(attemptedAt);
    discoveryFailureCache.delete(key);
    const resolved = document as OidcDiscoveryDocument;
    discoveryCache.set(key, { document: resolved, fetchedAt: now });
    return { ok: true, document: resolved };
  } catch {
    breaker.recordFailure(attemptedAt);
    discoveryFailureCache.set(key, now);
    return { ok: false };
  }
}

export type GenericJwks = { keys: Record<string, unknown>[] };

const jwksCache = new Map<string, { jwks: GenericJwks; fetchedAt: number }>();
const jwksFailureCache = new Map<string, number>();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

export type FetchJwksResult = { ok: true; jwks: GenericJwks } | { ok: false };

/**
 * Same breaker-tripping rule as `discoverOidcConfiguration`/
 * `exchangeAuthorizationCode` — only a genuine transport failure counts.
 * Same negative-TTL-cache rationale as `discoverOidcConfiguration` too
 * (Issue #610), and the SAME `${tenantId}:${providerKey}` scoping
 * requirement (Issue #610's own follow-up fix) — see that function's
 * comment on both above.
 */
export async function fetchProviderJwks(
  tenantId: string,
  providerKey: string,
  jwksUri: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<FetchJwksResult> {
  const key = scopedProviderKey(tenantId, providerKey);
  const cached = jwksCache.get(key);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return { ok: true, jwks: cached.jwks };
  }

  const recentFailure = jwksFailureCache.get(key);

  if (
    recentFailure !== undefined &&
    now - recentFailure < NEGATIVE_CACHE_TTL_MS
  ) {
    return { ok: false };
  }

  const breaker = getProviderCircuitBreaker(`sso-oidc-jwks:${key}`);
  const attemptedAt = new Date();

  if (!breaker.canAttempt(attemptedAt)) {
    jwksFailureCache.set(key, now);
    return { ok: false };
  }

  try {
    const response = await withTimeout(
      fetch(jwksUri),
      resolveSsoDiscoveryTimeoutMs(env),
      `oidc jwks fetch (${key})`
    );

    if (response.status < 200 || response.status >= 300) {
      breaker.recordFailure(attemptedAt);
      jwksFailureCache.set(key, now);
      return { ok: false };
    }

    const jwks = (await response
      .json()
      .catch(() => null)) as GenericJwks | null;

    if (!jwks || !Array.isArray(jwks.keys)) {
      breaker.recordFailure(attemptedAt);
      jwksFailureCache.set(key, now);
      return { ok: false };
    }

    breaker.recordSuccess(attemptedAt);
    jwksFailureCache.delete(key);
    jwksCache.set(key, { jwks, fetchedAt: now });
    return { ok: true, jwks };
  } catch {
    breaker.recordFailure(attemptedAt);
    jwksFailureCache.set(key, now);
    return { ok: false };
  }
}

export type ExchangeCodeParams = {
  tenantId: string;
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
 * input) and returns a non-retryable failure. Breaker key includes
 * `tenantId` (Issue #610's follow-up fix) for the same reason as
 * `discoverOidcConfiguration`/`fetchProviderJwks` above.
 */
export async function exchangeAuthorizationCode(
  params: ExchangeCodeParams
): Promise<ExchangeCodeResult> {
  const key = scopedProviderKey(params.tenantId, params.providerKey);
  const breaker = getProviderCircuitBreaker(`sso-oidc-token:${key}`);
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
      `oidc token exchange (${key})`
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
  discoveryFailureCache.clear();
  jwksFailureCache.clear();
}
