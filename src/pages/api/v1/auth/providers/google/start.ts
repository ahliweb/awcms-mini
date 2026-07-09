import type { APIRoute } from "astro";
import { fail } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { TENANT_COOKIE_NAME } from "../../../../../../lib/auth/ssr-session";
import {
  isGoogleLoginRequired,
  resolveGoogleClientId
} from "../../../../../../lib/auth/google-oidc-config";
import { createOAuthRequest } from "../../../../../../modules/identity-access/application/google-oidc";
import { buildGoogleAuthorizationUrl } from "../../../../../../lib/auth/google-oauth-client";

const OAUTH_REQUEST_TTL_SEC = 600;

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
 */
export const GET: APIRoute = async ({ request, cookies, url }) => {
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

  const { state, nonce } = await withTenant(sql, tenantId, (tx) =>
    createOAuthRequest(tx, tenantId, "login", null, OAUTH_REQUEST_TTL_SEC, now)
  );

  const authorizationUrl = buildGoogleAuthorizationUrl({
    clientId,
    tenantId,
    state,
    nonce
  });

  return new Response(null, {
    status: 302,
    headers: { Location: authorizationUrl }
  });
};
