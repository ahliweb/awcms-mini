import type { APIRoute } from "astro";
import { fail } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { TENANT_COOKIE_NAME } from "../../../../../../lib/auth/ssr-session";
import {
  checkRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import {
  isGoogleLoginRequired,
  resolveGoogleClientId
} from "../../../../../../lib/auth/google-oidc-config";
import { createOAuthRequest } from "../../../../../../modules/identity-access/application/google-oidc";
import { buildGoogleAuthorizationUrl } from "../../../../../../lib/auth/google-oauth-client";

const OAUTH_REQUEST_TTL_SEC = 600;
const RATE_LIMIT_MAX_ATTEMPTS = Number(
  process.env.AUTH_LOGIN_RATE_LIMIT_MAX ?? 20
);
const RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC ?? 60
);

/**
 * `GET /api/v1/auth/providers/google/start` (Issue #590) — unauthenticated
 * entry point reached from the "Continue with Google" button on
 * `login.astro`. Always `purpose = "login"` — linking an ALREADY
 * authenticated identity's Google account is a separate, POST-initiated
 * flow (`POST .../link`), since that one needs the caller's session to
 * know which identity to attach to, and a plain `<a href>`/redirect can't
 * carry an `Authorization` header the way a `fetch()` call can.
 *
 * Tenant resolution accepts a `?tenantId=` query param as a fallback after
 * the header/cookie, specifically because `login.astro` has no tenant
 * cookie yet pre-login (the user types their Tenant ID into a plain text
 * field) and a top-level navigation can't set the
 * `X-AWCMS-Mini-Tenant-ID` header every other endpoint relies on instead.
 *
 * Rate-limited (same shape as `login.ts`) AND — critically — the tenant's
 * existence/status is checked via a plain `SELECT` BEFORE ever inserting
 * into `awcms_mini_oidc_auth_requests`. Security review of this PR found
 * that inserting directly with an unauthenticated, caller-supplied
 * `tenantId` let a nonexistent tenant id trip a foreign-key violation,
 * which `withTenant`'s catch-all treats as an infrastructure failure and
 * records against the single, APPLICATION-WIDE database circuit breaker
 * (`getDatabaseCircuitBreaker()` — shared across every tenant and every
 * endpoint, unlike the per-provider breakers Turnstile/Google's own token
 * exchange use). An unauthenticated caller could open that breaker with 5
 * garbage tenant ids and take down the entire deployment for 30 seconds
 * at a time, repeatedly — a strictly worse blast radius than the #596
 * Turnstile bug this epic already fixed once. A `SELECT` never throws for
 * a missing row, so checking first (and returning a plain `403
 * ACCESS_DENIED` without ever attempting the insert) closes this off
 * completely, mirroring how `login.ts` itself already resolves tenant
 * status via `SELECT` before any write.
 */
export const GET: APIRoute = async ({
  request,
  cookies,
  url,
  clientAddress
}) => {
  if (!isGoogleLoginRequired()) {
    return fail(
      403,
      "GOOGLE_LOGIN_DISABLED",
      "Google login is not enabled for this deployment."
    );
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
  const rateLimit = checkRateLimit(
    `${clientIp}:${tenantId}:google-oauth-start`,
    {
      maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
  );

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

  const clientId = resolveGoogleClientId();

  if (!clientId) {
    return fail(
      500,
      "GOOGLE_MISCONFIGURED",
      "Google login is misconfigured on this server."
    );
  }

  const sql = getDatabaseClient();
  const now = new Date();

  const result = await withTenant(sql, tenantId, async (tx) => {
    const tenantRows = (await tx`
      SELECT status FROM awcms_mini_tenants WHERE id = ${tenantId}
    `) as { status: string }[];

    if (tenantRows[0]?.status !== "active") {
      return { ok: false as const };
    }

    const { state, nonce } = await createOAuthRequest(
      tx,
      tenantId,
      "login",
      null,
      OAUTH_REQUEST_TTL_SEC,
      now
    );

    return { ok: true as const, state, nonce };
  });

  if (!result.ok) {
    return fail(403, "ACCESS_DENIED", "Tenant is not active.");
  }

  const authorizationUrl = buildGoogleAuthorizationUrl({
    clientId,
    tenantId,
    state: result.state,
    nonce: result.nonce
  });

  return new Response(null, {
    status: 302,
    headers: { Location: authorizationUrl }
  });
};
