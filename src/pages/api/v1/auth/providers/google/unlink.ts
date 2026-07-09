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
import { isGoogleLoginRequired } from "../../../../../../lib/auth/google-oidc-config";
import { unlinkProviderAccount } from "../../../../../../modules/identity-access/application/google-oidc";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";

/**
 * `POST /api/v1/auth/providers/google/unlink` (Issue #590) — high-risk,
 * self-service action: authenticated identity removes its own linked
 * Google account. Local password login is never affected (issue's own
 * out-of-scope note: "Removing or disabling local password login" is out
 * of scope) — unlinking Google never touches `password_hash`.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
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

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const session = await resolveActiveSession(tx, tenantId, tokenHash, now);

    if (!session) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const result = await unlinkProviderAccount(
      tx,
      tenantId,
      session.identity_id
    );

    if (!result.ok) {
      return fail(
        409,
        result.code,
        "No Google account is currently linked for this identity."
      );
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: "identity_access",
      action: "google_account_unlinked",
      resourceType: "identity",
      resourceId: session.identity_id,
      severity: "warning",
      message: "Google account unlinked.",
      correlationId: locals.correlationId
    });

    return ok({ unlinked: true });
  });
};
