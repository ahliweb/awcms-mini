import type { APIRoute } from "astro";
import { fail } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  generateSessionToken,
  hashSessionToken
} from "../../../../../../lib/auth/session-token";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../../../../lib/auth/ssr-session";
import { isSsoRequired } from "../../../../../../lib/auth/sso-config";
import { completeTenantSsoCallback } from "../../../../../../modules/identity-access/application/tenant-sso";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";

const SESSION_TTL_MIN = Number(process.env.AUTH_SESSION_TTL_MIN ?? 120);

/**
 * `GET /api/v1/auth/sso/{providerKey}/callback` (Issue #591) — the
 * tenant-configured provider's own redirect target, same shape as Issue
 * #590's `providers/google/callback.ts`: plain top-level browser
 * navigation, raw JSON error responses (no dedicated error page yet, same
 * accepted trade-off), `state`/nonce/ID token validated cryptographically
 * before trusting any claim, MFA gate always checked before session
 * creation.
 */
export const GET: APIRoute = async ({ cookies, url, params, locals }) => {
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

  const providerError = url.searchParams.get("error");

  if (providerError) {
    return fail(
      401,
      "SSO_OAUTH_STATE_INVALID",
      "SSO sign-in was cancelled or denied."
    );
  }

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!state) {
    return fail(
      400,
      "SSO_OAUTH_STATE_INVALID",
      "Missing or invalid state parameter."
    );
  }

  const sql = getDatabaseClient();
  const now = new Date();

  const result = await completeTenantSsoCallback(
    sql,
    providerKey,
    state,
    code,
    process.env,
    now
  );

  if (result.outcome === "error") {
    const status =
      result.code === "SSO_PROVIDER_UNAVAILABLE"
        ? 502
        : result.code === "SSO_ALREADY_LINKED"
          ? 409
          : result.code === "ACCESS_DENIED" ||
              result.code === "SSO_PROVIDER_DISABLED"
            ? 403
            : 401;

    return fail(
      status,
      result.code,
      "SSO sign-in could not be completed. Please try again."
    );
  }

  if (result.outcome === "mfa_required") {
    await withTenant(sql, result.tenantId, (tx) =>
      recordAuditEvent(tx, {
        tenantId: result.tenantId,
        moduleKey: "identity_access",
        action: "mfa_challenge_issued",
        resourceType: "identity",
        resourceId: result.identityId,
        severity: "info",
        message: "SSO sign-in verified; MFA challenge issued.",
        correlationId: locals.correlationId
      })
    );

    return fail(
      401,
      "MFA_REQUIRED",
      "Multi-factor authentication is required to complete sign-in.",
      {},
      {
        mfaChallengeToken: result.challengeToken,
        expiresAt: result.challengeExpiresAt.toISOString()
      }
    );
  }

  if (result.outcome === "linked") {
    await withTenant(sql, result.tenantId, (tx) =>
      recordAuditEvent(tx, {
        tenantId: result.tenantId,
        moduleKey: "identity_access",
        action: "sso_account_linked",
        resourceType: "identity",
        resourceId: result.identityId,
        severity: "warning",
        message: `SSO account linked (provider: ${providerKey}).`,
        attributes: { providerKey },
        correlationId: locals.correlationId
      })
    );

    return new Response(null, {
      status: 302,
      headers: { Location: "/admin" }
    });
  }

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MIN * 60_000);

  await withTenant(sql, result.tenantId, async (tx) => {
    await tx`
      UPDATE awcms_mini_identities
      SET failed_login_count = 0, last_login_at = ${now}
      WHERE id = ${result.identityId}
    `;

    await tx`
      INSERT INTO awcms_mini_sessions (tenant_id, identity_id, token_hash, expires_at)
      VALUES (${result.tenantId}, ${result.identityId}, ${tokenHash}, ${expiresAt})
    `;

    await recordAuditEvent(tx, {
      tenantId: result.tenantId,
      moduleKey: "identity_access",
      action: "sso_login_succeeded",
      resourceType: "identity",
      resourceId: result.identityId,
      severity: "info",
      message: `SSO sign-in succeeded; session created (provider: ${providerKey}).`,
      attributes: { providerKey },
      correlationId: locals.correlationId
    });
  });

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MIN * 60,
    secure: process.env.AUTH_COOKIE_SECURE === "true"
  };
  cookies.set(SESSION_COOKIE_NAME, token, cookieOptions);
  cookies.set(TENANT_COOKIE_NAME, result.tenantId, cookieOptions);

  return new Response(null, {
    status: 302,
    headers: { Location: "/admin" }
  });
};
