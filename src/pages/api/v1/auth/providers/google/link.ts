import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../../../../lib/auth/ssr-session";
import {
  extractBearerToken,
  resolveActiveSession
} from "../../../../../../modules/identity-access/application/session-lookup";
import {
  isGoogleLoginRequired,
  resolveGoogleClientId
} from "../../../../../../lib/auth/google-oidc-config";
import { createOAuthRequest } from "../../../../../../modules/identity-access/application/google-oidc";
import { buildGoogleAuthorizationUrl } from "../../../../../../lib/auth/google-oauth-client";

const OAUTH_REQUEST_TTL_SEC = 600;

/**
 * `POST /api/v1/auth/providers/google/link` (Issue #590) — authenticated:
 * starts a link-purpose OAuth request for the CALLER's own identity
 * (captured server-side here, never trusted from the eventual callback
 * request) and returns the Google authorization URL as JSON for the client
 * to navigate to (`window.location = data.data.authorizationUrl`) — a
 * POST-returning-JSON shape rather than a redirect, since this is invoked
 * via `fetch()` from an already-authenticated context (unlike
 * `GET .../start`, reached from a plain `<a href>` on the unauthenticated
 * login page).
 */
export const POST: APIRoute = async ({ request, cookies }) => {
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
    null;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token =
    extractBearerToken(request.headers.get("authorization")) ??
    cookies.get(SESSION_COOKIE_NAME)?.value ??
    null;

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
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
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const session = await resolveActiveSession(tx, tenantId, tokenHash, now);

    if (!session) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const { state, nonce } = await createOAuthRequest(
      tx,
      tenantId,
      "link",
      session.identity_id,
      OAUTH_REQUEST_TTL_SEC,
      now
    );

    const authorizationUrl = buildGoogleAuthorizationUrl({
      clientId,
      tenantId,
      state,
      nonce
    });

    return ok({ authorizationUrl });
  });
};
