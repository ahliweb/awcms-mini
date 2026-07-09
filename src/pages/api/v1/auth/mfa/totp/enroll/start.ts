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
import { startTotpEnrollment } from "../../../../../../../modules/identity-access/application/mfa";

/**
 * `POST /api/v1/auth/mfa/totp/enroll/start` (Issue #589) — generates a fresh
 * TOTP secret and stores it as a `pending` factor (unusable for login until
 * `enroll/verify` confirms a code against it). The plaintext secret/QR URI
 * is only ever returned here, at enrollment start — never again afterward.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
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

    const identityRows = (await tx`
      SELECT login_identifier FROM awcms_mini_identities WHERE id = ${session.identity_id}
    `) as { login_identifier: string }[];
    const loginIdentifier = identityRows[0]?.login_identifier ?? "user";

    const result = await startTotpEnrollment(
      tx,
      tenantId,
      session.identity_id,
      loginIdentifier,
      process.env,
      now
    );

    if (!result.ok) {
      const status = result.code === "MFA_ALREADY_ACTIVE" ? 409 : 500;

      return fail(
        status,
        result.code,
        result.code === "MFA_ALREADY_ACTIVE"
          ? "Multi-factor authentication is already active for this account."
          : "Multi-factor authentication is misconfigured on this server."
      );
    }

    return ok({
      secret: result.secretBase32,
      otpauthUri: result.otpauthUri
    });
  });
};
