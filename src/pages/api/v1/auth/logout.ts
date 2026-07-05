import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../../lib/auth/ssr-session";
import {
  extractBearerToken,
  resolveActiveSession
} from "../../../../modules/identity-access/application/session-lookup";

export const POST: APIRoute = async ({ request, cookies }) => {
  // Bearer token + tenant header (existing bearer-token clients/tests) take
  // priority and are unchanged. Additive (Issue 8.1): fall back to the
  // httpOnly session cookies when the header is absent, so the SSR admin
  // shell's logout button can revoke its session without ever reading the
  // httpOnly cookie value from client-side JavaScript.
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

    await tx`
      UPDATE awcms_mini_sessions
      SET revoked_at = ${now}
      WHERE tenant_id = ${tenantId} AND id = ${session.id}
    `;

    // Additive (Issue 8.1): clear both SSR auth cookies alongside the
    // existing session-revoke logic above.
    cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
    cookies.delete(TENANT_COOKIE_NAME, { path: "/" });

    return ok({ loggedOut: true });
  });
};
