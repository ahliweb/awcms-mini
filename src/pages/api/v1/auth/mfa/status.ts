import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../../../lib/auth/ssr-session";
import {
  extractBearerToken,
  resolveActiveSession
} from "../../../../../modules/identity-access/application/session-lookup";
import { isMfaRequired } from "../../../../../lib/auth/mfa-config";
import { getMfaStatus } from "../../../../../modules/identity-access/application/mfa";

/**
 * `GET /api/v1/auth/mfa/status` (Issue #589) — the current identity's own
 * MFA enrollment state. Same bearer-token-with-cookie-fallback
 * authentication as `POST /auth/logout`. `403 MFA_DISABLED` when the
 * feature isn't active for this deployment (Issue #587 gate off or
 * `AUTH_MFA_ENABLED` not `"true"`) — every MFA endpoint gates identically so
 * the feature is entirely inert (no DB read even attempted) when disabled.
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  if (!isMfaRequired()) {
    return fail(
      403,
      "MFA_DISABLED",
      "Multi-factor authentication is not enabled for this deployment."
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

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const session = await resolveActiveSession(tx, tenantId, tokenHash, now);

    if (!session) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const status = await getMfaStatus(tx, tenantId, session.identity_id);

    return ok(status);
  });
};
