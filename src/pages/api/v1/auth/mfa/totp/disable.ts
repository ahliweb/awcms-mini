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
import { isMfaRequired } from "../../../../../../lib/auth/mfa-config";
import { disableMfa } from "../../../../../../modules/identity-access/application/mfa";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";

/**
 * `POST /api/v1/auth/mfa/totp/disable` (Issue #589) — high-risk,
 * self-service action: authenticated identity turns off its own MFA.
 * Requires an already-valid session (which, for an identity with active MFA,
 * can only have been obtained by already passing an MFA challenge) plus an
 * audit trail — matches the issue's "disable MFA... must require
 * authorization and audit" requirement without inventing a second
 * confirmation step beyond the session itself.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
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

    const result = await disableMfa(tx, tenantId, session.identity_id, now);

    if (!result.ok) {
      return fail(
        409,
        result.code,
        "Multi-factor authentication is not currently active for this account."
      );
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: "identity_access",
      action: "mfa_disabled",
      resourceType: "identity",
      resourceId: session.identity_id,
      severity: "warning",
      message: "Multi-factor authentication disabled.",
      correlationId: locals.correlationId
    });

    return ok({ disabled: true });
  });
};
