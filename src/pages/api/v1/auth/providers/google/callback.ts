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
import { isGoogleLoginRequired } from "../../../../../../lib/auth/google-oidc-config";
import { completeGoogleOAuthCallback } from "../../../../../../modules/identity-access/application/google-oidc";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";

const SESSION_TTL_MIN = Number(process.env.AUTH_SESSION_TTL_MIN ?? 120);

/**
 * `GET /api/v1/auth/providers/google/callback` (Issue #590) — Google's own
 * redirect target, a plain top-level browser navigation (never a `fetch()`
 * call), so error responses here are necessarily raw JSON shown in the
 * browser rather than a styled page — the same tradeoff `password/reset.ts`
 * accepts today for a repo with no dedicated reset-password UI page yet.
 * A follow-up issue could add a proper `/login` error redirect; out of
 * scope for #590's own endpoint-focused acceptance criteria.
 */
export const GET: APIRoute = async ({ cookies, url, locals }) => {
  if (!isGoogleLoginRequired()) {
    return fail(
      403,
      "GOOGLE_LOGIN_DISABLED",
      "Google login is not enabled for this deployment."
    );
  }

  const providerError = url.searchParams.get("error");

  if (providerError) {
    return fail(
      401,
      "GOOGLE_OAUTH_STATE_INVALID",
      "Google sign-in was cancelled or denied."
    );
  }

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!state) {
    return fail(
      400,
      "GOOGLE_OAUTH_STATE_INVALID",
      "Missing or invalid state parameter."
    );
  }

  const sql = getDatabaseClient();
  const now = new Date();

  const result = await completeGoogleOAuthCallback(
    sql,
    state,
    code,
    process.env,
    now
  );

  if (result.outcome === "error") {
    const status =
      result.code === "GOOGLE_MISCONFIGURED"
        ? 500
        : result.code === "GOOGLE_ALREADY_LINKED"
          ? 409
          : result.code === "ACCESS_DENIED"
            ? 403
            : 401;

    return fail(
      status,
      result.code,
      "Google sign-in could not be completed. Please try again."
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
        message: "Google sign-in verified; MFA challenge issued.",
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
        action: "google_account_linked",
        resourceType: "identity",
        resourceId: result.identityId,
        severity: "warning",
        message: "Google account linked.",
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
      action: "google_login_succeeded",
      resourceType: "identity",
      resourceId: result.identityId,
      severity: "info",
      message: "Google sign-in succeeded; session created.",
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
