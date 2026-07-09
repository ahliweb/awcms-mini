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
import { isSsoRequired } from "../../../../../../lib/auth/sso-config";
import { unlinkProviderAccount } from "../../../../../../modules/identity-access/application/tenant-sso";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";

/**
 * `POST /api/v1/auth/sso/{providerKey}/unlink` (Issue #591) — high-risk,
 * self-service action, same shape as Issue #590's
 * `providers/google/unlink.ts`. Never touches local password login —
 * unlinking a provider cannot lock an identity out of its own account
 * (that guarantee is the tenant policy's `sso_required` + break-glass
 * enforcement's job instead, checked at policy-save time).
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
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
      providerKey,
      session.identity_id
    );

    if (!result.ok) {
      return fail(
        409,
        result.code,
        "No SSO account is currently linked for this identity and provider."
      );
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: "identity_access",
      action: "sso_account_unlinked",
      resourceType: "identity",
      resourceId: session.identity_id,
      severity: "warning",
      message: `SSO account unlinked (provider: ${providerKey}).`,
      attributes: { providerKey },
      correlationId: locals.correlationId
    });

    return ok({ unlinked: true });
  });
};
