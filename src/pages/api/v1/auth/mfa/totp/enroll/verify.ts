import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../../../../../lib/auth/ssr-session";
import {
  extractBearerToken,
  resolveActiveSession
} from "../../../../../../../modules/identity-access/application/session-lookup";
import { isMfaRequired } from "../../../../../../../lib/auth/mfa-config";
import { verifyTotpEnrollment } from "../../../../../../../modules/identity-access/application/mfa";
import { recordAuditEvent } from "../../../../../../../modules/logging/application/audit-log";

type VerifyEnrollmentBody = { code?: unknown };

/**
 * `POST /api/v1/auth/mfa/totp/enroll/verify` (Issue #589) — confirms the
 * pending secret from `enroll/start` with a live TOTP code, activating the
 * factor and returning 10 single-use recovery codes shown exactly once
 * (never retrievable again — only `recovery-codes/regenerate` can produce a
 * fresh set afterward, invalidating these).
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

  const body = (await request
    .json()
    .catch(() => null)) as VerifyEnrollmentBody | null;

  if (!body || typeof body.code !== "string") {
    return fail(400, "VALIDATION_ERROR", "code is required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const session = await resolveActiveSession(tx, tenantId, tokenHash, now);

    if (!session) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const result = await verifyTotpEnrollment(
      tx,
      tenantId,
      session.identity_id,
      body.code as string,
      process.env,
      now
    );

    if (!result.ok) {
      const status =
        result.code === "MFA_ENROLLMENT_NOT_FOUND"
          ? 404
          : result.code === "MFA_INVALID_CODE"
            ? 400
            : 500;

      return fail(
        status,
        result.code,
        result.code === "MFA_ENROLLMENT_NOT_FOUND"
          ? "No pending MFA enrollment found. Start enrollment again."
          : result.code === "MFA_INVALID_CODE"
            ? "Invalid verification code."
            : "Multi-factor authentication is misconfigured on this server."
      );
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: undefined,
      moduleKey: "identity_access",
      action: "mfa_enrolled",
      resourceType: "identity",
      resourceId: session.identity_id,
      severity: "warning",
      message: "Multi-factor authentication (TOTP) enrolled and activated.",
      correlationId: locals.correlationId
    });

    return ok({ activated: true, recoveryCodes: result.recoveryCodes });
  });
};
