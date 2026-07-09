/**
 * Google OAuth/OIDC network calls (Issue #590) — authorization-code token
 * exchange and JWKS fetch. Same timeout + circuit-breaker pattern as
 * `../security/turnstile.ts`/`tenant-domain/infrastructure/cloudflare-dns-adapter.ts`
 * — and the SAME fix PR #596's security review forced onto Turnstile: the
 * circuit breaker only trips on a genuine transport-level problem with
 * Google's endpoints (non-2xx HTTP status the caller didn't itself cause,
 * network error, timeout), NEVER on a well-formed error response driven by
 * attacker-controlled input (e.g. a bad/reused/expired authorization `code`
 * — Google's token endpoint answers that with `400 {"error":"invalid_grant"}`,
 * which is Google correctly rejecting a bad client request, not Google being
 * unhealthy). Getting this wrong a second time, after #596, would let anyone
 * lock out Google login for every tenant by replaying a handful of stale
 * authorization codes.
 */
import { getProviderCircuitBreaker } from "../database/circuit-breaker";
import { withTimeout } from "../integration/timeout";
import {
  GOOGLE_OIDC_ENDPOINTS,
  resolveGoogleRedirectPath
} from "./google-oidc-config";
import { buildOAuthStateParam } from "./oauth-state-token";

export type BuildAuthorizationUrlParams = {
  clientId: string;
  tenantId: string;
  state: string;
  nonce: string;
};

/** Resolves the `redirect_uri` Google is told to send the browser back to — always this deployment's own `AUTH_GOOGLE_REDIRECT_PATH` under `APP_URL`, never client-supplied (open-redirect prevention). */
export function resolveGoogleRedirectUri(
  env: NodeJS.ProcessEnv = process.env
): string {
  const appUrl = env.APP_URL ?? "http://localhost:4321";
  return new URL(resolveGoogleRedirectPath(env), appUrl).toString();
}

/** Builds the full `https://accounts.google.com/o/oauth2/v2/auth?...` URL for `start.ts`/`link.ts` to redirect to. */
export function buildGoogleAuthorizationUrl(
  params: BuildAuthorizationUrlParams
): string {
  const authorizationUrl = new URL(GOOGLE_OIDC_ENDPOINTS.authorizationEndpoint);
  authorizationUrl.searchParams.set("client_id", params.clientId);
  authorizationUrl.searchParams.set("redirect_uri", resolveGoogleRedirectUri());
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid email profile");
  authorizationUrl.searchParams.set(
    "state",
    buildOAuthStateParam(params.tenantId, params.state)
  );
  authorizationUrl.searchParams.set("nonce", params.nonce);

  return authorizationUrl.toString();
}

const TOKEN_EXCHANGE_BREAKER_KEY = "google-oidc-token";
const JWKS_BREAKER_KEY = "google-oidc-jwks";
const DEFAULT_TIMEOUT_MS = 5_000;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

export type ExchangeCodeParams = {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  timeoutMs?: number;
  /** Test-only override for `GOOGLE_OIDC_ENDPOINTS.tokenEndpoint`. */
  tokenEndpoint?: string;
};

export type ExchangeCodeResult =
  { ok: true; idToken: string } | { ok: false; retryable: boolean };

/**
 * Authorization Code exchange (issue's own security note: "Use
 * Authorization Code flow with state and nonce"). A non-2xx response is
 * only ever treated as a provider-transport failure (breaker-tripping) when
 * it's a genuine server error (5xx) — Google's own documented `400
 * invalid_grant`/`invalid_client` responses for a bad `code` are the
 * expected, attacker-repeatable outcome for garbage input and must never
 * trip the shared breaker (see file header).
 */
export async function exchangeAuthorizationCode(
  params: ExchangeCodeParams
): Promise<ExchangeCodeResult> {
  const breaker = getProviderCircuitBreaker(TOKEN_EXCHANGE_BREAKER_KEY);
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
      fetch(params.tokenEndpoint ?? GOOGLE_OIDC_ENDPOINTS.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }),
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "google oidc token exchange"
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
      // Google correctly answered a bad request (invalid_grant, expired/
      // reused code, wrong redirect_uri, etc.) — a healthy-provider signal,
      // not a failure of Google itself.
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

export type GoogleJwks = { keys: Record<string, unknown>[] };

let cachedJwks: { jwks: GoogleJwks; fetchedAt: number } | null = null;

export type FetchJwksParams = {
  timeoutMs?: number;
  /** Test-only override for `GOOGLE_OIDC_ENDPOINTS.jwksUri`. */
  jwksUri?: string;
};

export type FetchJwksResult = { ok: true; jwks: GoogleJwks } | { ok: false };

/**
 * Fetches (and caches for `JWKS_CACHE_TTL_MS`, matching standard JWKS
 * client practice — Google's own keys rotate infrequently) Google's public
 * signing keys. Same breaker-tripping rule as `exchangeAuthorizationCode`:
 * only a genuine transport failure counts.
 */
export async function fetchGoogleJwks(
  params: FetchJwksParams = {}
): Promise<FetchJwksResult> {
  const now = Date.now();

  if (cachedJwks && now - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return { ok: true, jwks: cachedJwks.jwks };
  }

  const breaker = getProviderCircuitBreaker(JWKS_BREAKER_KEY);
  const attemptedAt = new Date();

  if (!breaker.canAttempt(attemptedAt)) {
    return { ok: false };
  }

  try {
    const response = await withTimeout(
      fetch(params.jwksUri ?? GOOGLE_OIDC_ENDPOINTS.jwksUri),
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "google oidc jwks fetch"
    );

    if (response.status < 200 || response.status >= 300) {
      breaker.recordFailure(attemptedAt);
      return { ok: false };
    }

    const jwks = (await response.json().catch(() => null)) as GoogleJwks | null;

    if (!jwks || !Array.isArray(jwks.keys)) {
      breaker.recordFailure(attemptedAt);
      return { ok: false };
    }

    breaker.recordSuccess(attemptedAt);
    cachedJwks = { jwks, fetchedAt: now };
    return { ok: true, jwks };
  } catch {
    breaker.recordFailure(attemptedAt);
    return { ok: false };
  }
}

/** Test-only: clears the in-memory JWKS cache so test files don't bleed into each other. */
export function resetGoogleJwksCacheForTests(): void {
  cachedJwks = null;
}
