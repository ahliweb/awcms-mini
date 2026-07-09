import type { APIRoute } from "astro";
import { fail } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { TENANT_COOKIE_NAME } from "../../../../../../lib/auth/ssr-session";
import {
  checkRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { isSsoRequired } from "../../../../../../lib/auth/sso-config";
import {
  buildSsoAuthorizationUrl,
  createSsoOAuthRequest
} from "../../../../../../modules/identity-access/application/tenant-sso";
import { fetchAuthProviderRowByKey } from "../../../../../../modules/identity-access/application/auth-provider-directory";

const OAUTH_REQUEST_TTL_SEC = 600;
const RATE_LIMIT_MAX_ATTEMPTS = Number(
  process.env.AUTH_LOGIN_RATE_LIMIT_MAX ?? 20
);
const RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC ?? 60
);

/**
 * Aggregate (NOT per-source) budget for this one `providerKey`, on top of
 * the per-source+tenant limiter above (Issue #610, follow-up from the
 * Issue #603 SSRF risk-acceptance decision). The per-source limiter bounds
 * how fast any ONE client can hit this endpoint, but does nothing against
 * many different source IPs each staying under that limit while probing
 * the SAME tenant-configured `issuer_url` in aggregate — this second
 * check bounds total request volume against one specific provider
 * regardless of how many distinct sources it comes from. Default is
 * generous enough for legitimate concurrent SSO logins to a popular
 * provider within one tenant; tune down for stricter environments.
 */
const PROVIDER_RATE_LIMIT_MAX_ATTEMPTS = Number(
  process.env.AUTH_SSO_PROVIDER_RATE_LIMIT_MAX ?? 60
);
const PROVIDER_RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_SSO_PROVIDER_RATE_LIMIT_WINDOW_SEC ?? 60
);

/**
 * `GET /api/v1/auth/sso/{providerKey}/start` (Issue #591) — unauthenticated
 * entry point, same shape as Issue #590's `providers/google/start.ts`:
 * `tenantId` resolved from header/cookie/`?tenantId=` query param fallback
 * (a plain browser navigation to a tenant-configured provider has no
 * tenant cookie yet either), tenant existence/status checked via a plain
 * `SELECT` BEFORE any INSERT (PR #598's fix, applied here from day one to
 * avoid re-introducing the shared-database-circuit-breaker DoS it found).
 * `404 SSO_PROVIDER_NOT_FOUND` (not the gate's own `403`) once the gate is
 * confirmed active but the provider key doesn't resolve to an enabled
 * provider for this tenant — avoids leaking a distinct signal for "gate
 * off" vs "provider key wrong" beyond what's already unavoidable.
 */
export const GET: APIRoute = async ({
  request,
  cookies,
  url,
  params,
  clientAddress
}) => {
  if (!isSsoRequired()) {
    return fail(
      403,
      "SSO_DISABLED",
      "Tenant OIDC SSO is not enabled for this deployment."
    );
  }

  const providerKey = params.providerKey;

  if (!providerKey) {
    return fail(400, "VALIDATION_ERROR", "providerKey is required.");
  }

  const tenantId =
    request.headers.get("x-awcms-mini-tenant-id") ??
    cookies.get(TENANT_COOKIE_NAME)?.value ??
    url.searchParams.get("tenantId") ??
    null;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = checkRateLimit(`${clientIp}:${tenantId}:sso-start`, {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_SEC * 1000
  });

  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests from this source. Try again later.",
      {},
      undefined,
      { "retry-after": String(rateLimit.retryAfterSec) }
    );
  }

  // Aggregate-across-sources check (Issue #610) — deliberately a SEPARATE
  // key/bucket from the per-source one above, so a distributed prober
  // rotating source IPs against this one provider still gets capped.
  const providerRateLimit = checkRateLimit(
    `${tenantId}:${providerKey}:sso-provider-start`,
    {
      maxAttempts: PROVIDER_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: PROVIDER_RATE_LIMIT_WINDOW_SEC * 1000
    }
  );

  if (!providerRateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests for this provider. Try again later.",
      {},
      undefined,
      { "retry-after": String(providerRateLimit.retryAfterSec) }
    );
  }

  const sql = getDatabaseClient();
  const now = new Date();

  const result = await withTenant(sql, tenantId, async (tx) => {
    const tenantRows = (await tx`
      SELECT status FROM awcms_mini_tenants WHERE id = ${tenantId}
    `) as { status: string }[];

    if (tenantRows[0]?.status !== "active") {
      return { outcome: "denied" as const };
    }

    const provider = await fetchAuthProviderRowByKey(tx, tenantId, providerKey);

    if (!provider || !provider.enabled) {
      return { outcome: "not_found" as const };
    }

    const { state, nonce } = await createSsoOAuthRequest(
      tx,
      tenantId,
      providerKey,
      "login",
      null,
      OAUTH_REQUEST_TTL_SEC,
      now
    );

    return { outcome: "ready" as const, provider, state, nonce };
  });

  if (result.outcome === "denied") {
    return fail(403, "ACCESS_DENIED", "Tenant is not active.");
  }

  if (result.outcome === "not_found") {
    return fail(
      404,
      "SSO_PROVIDER_NOT_FOUND",
      "No enabled SSO provider matches this key."
    );
  }

  const authorizationResult = await buildSsoAuthorizationUrl(
    result.provider,
    tenantId,
    result.state,
    result.nonce
  );

  if (!authorizationResult.ok) {
    return fail(
      502,
      authorizationResult.code,
      "The SSO provider could not be reached. Try again later."
    );
  }

  return new Response(null, {
    status: 302,
    headers: { Location: authorizationResult.authorizationUrl }
  });
};
