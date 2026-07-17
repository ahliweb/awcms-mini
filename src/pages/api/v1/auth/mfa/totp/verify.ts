import type { APIRoute } from "astro";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
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
import {
  checkRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { verifyMfaChallenge } from "../../../../../../modules/identity-access/application/mfa";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import {
  hashClientIp,
  summarizeUserAgent
} from "../../../../../../lib/security/client-fingerprint";

const SESSION_TTL_MIN = Number(process.env.AUTH_SESSION_TTL_MIN ?? 120);
const RATE_LIMIT_MAX_ATTEMPTS = Number(
  process.env.AUTH_MFA_RATE_LIMIT_MAX ?? 5
);
const RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_MFA_RATE_LIMIT_WINDOW_SEC ?? 300
);
const CHALLENGE_MAX_ATTEMPTS = RATE_LIMIT_MAX_ATTEMPTS;

type VerifyChallengeBody = {
  mfaChallengeToken?: unknown;
  code?: unknown;
  recoveryCode?: unknown;
};

/**
 * `POST /api/v1/auth/mfa/totp/verify` (Issue #589) — completes a login that
 * `POST /auth/login` paused with `401 MFA_REQUIRED`. Deliberately NOT
 * authenticated via the existing session cookie/bearer token (there isn't
 * one yet — that's the whole point of the challenge) — authenticated
 * instead by possession of `mfaChallengeToken`, exactly like
 * `password/reset.ts` is authenticated by possession of a reset token
 * rather than a session. On success, creates the real AWCMS-Mini session
 * exactly like `login.ts` does (same cookies, same response shape) so
 * client code doesn't need to special-case a two-step login.
 *
 * Rate-limited two ways: source+tenant scoped (same shape as
 * `login.ts`/`password/forgot.ts`) AND per-challenge `failed_attempts`
 * (`verifyMfaChallenge`) — the latter bounds a distributed attacker
 * rotating source IPs against one stolen/guessed challenge token, which the
 * former alone would not catch.
 */
export const POST: APIRoute = async ({
  request,
  cookies,
  clientAddress,
  locals
}) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = checkRateLimit(`${clientIp}:${tenantId}:mfa-verify`, {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_SEC * 1000
  });

  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many verification attempts from this source. Try again later.",
      {},
      undefined,
      { "retry-after": String(rateLimit.retryAfterSec) }
    );
  }

  const body = (await request
    .json()
    .catch(() => null)) as VerifyChallengeBody | null;

  if (
    !body ||
    typeof body.mfaChallengeToken !== "string" ||
    (typeof body.code !== "string" && typeof body.recoveryCode !== "string")
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "mfaChallengeToken and either code or recoveryCode are required."
    );
  }

  const sql = getDatabaseClient();
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const result = await verifyMfaChallenge(
      tx,
      tenantId,
      body.mfaChallengeToken as string,
      {
        code: typeof body.code === "string" ? body.code : undefined,
        recoveryCode:
          typeof body.recoveryCode === "string" ? body.recoveryCode : undefined
      },
      process.env,
      CHALLENGE_MAX_ATTEMPTS,
      now
    );

    if (!result.ok) {
      const status = result.code === "MFA_MISCONFIGURED" ? 500 : 401;

      // Issue #821 — the second factor is the last gate in front of a session
      // for a caller who already proved the password, so a failure here is a
      // higher-signal brute-force indicator than a plain `login_failed`, yet
      // it was the one auth outcome in this file left untraced.
      //
      // No `resourceId`: an invalid/expired/replayed challenge token does not
      // resolve to an identity (`verifyMfaChallenge` returns none on the `!ok`
      // path), and the token itself must never be persisted. `result.code` is
      // a fixed enum, not caller-controlled text.
      await recordAuditEvent(tx, {
        tenantId,
        moduleKey: "identity_access",
        action: "mfa_challenge_failed",
        resourceType: "identity",
        severity: "warning",
        message: `MFA challenge verification failed: ${result.code}.`,
        attributes: {
          reason: result.code,
          ipHash: hashClientIp(clientIp),
          userAgent: summarizeUserAgent(request)
        },
        correlationId: locals.correlationId
      });

      return fail(
        status,
        result.code,
        result.code === "MFA_MISCONFIGURED"
          ? "Multi-factor authentication is misconfigured on this server."
          : "This MFA challenge is invalid, expired, or already used."
      );
    }

    const identityId = result.identityId;
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MIN * 60_000);

    await tx`
      UPDATE awcms_mini_identities
      SET failed_login_count = 0, last_login_at = ${now}
      WHERE id = ${identityId}
    `;

    await tx`
      INSERT INTO awcms_mini_sessions (tenant_id, identity_id, token_hash, expires_at)
      VALUES (${tenantId}, ${identityId}, ${tokenHash}, ${expiresAt})
    `;

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: "identity_access",
      action: "mfa_challenge_verified",
      resourceType: "identity",
      resourceId: identityId,
      severity: "info",
      message: "MFA challenge verified; session created.",
      // Same source fingerprint as the `login_failed`/`mfa_challenge_failed`
      // rows, so an operator can follow one source across the whole two-step
      // sign-in rather than only across its failures (Issue #821).
      attributes: {
        method: "mfa",
        ipHash: hashClientIp(clientIp),
        userAgent: summarizeUserAgent(request)
      },
      correlationId: locals.correlationId
    });

    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: SESSION_TTL_MIN * 60,
      secure: process.env.AUTH_COOKIE_SECURE === "true"
    };
    cookies.set(SESSION_COOKIE_NAME, token, cookieOptions);
    cookies.set(TENANT_COOKIE_NAME, tenantId, cookieOptions);

    return ok({ token, expiresAt: expiresAt.toISOString() });
  });
};
