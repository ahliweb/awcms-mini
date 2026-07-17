import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { evaluateLoginAttempt } from "../../../../modules/identity-access/domain/login-policy";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { verifyPassword } from "../../../../lib/auth/password";
import {
  generateSessionToken,
  hashSessionToken
} from "../../../../lib/auth/session-token";
import {
  SESSION_COOKIE_NAME,
  TENANT_COOKIE_NAME
} from "../../../../lib/auth/ssr-session";
import {
  checkRateLimit,
  resolveClientIp
} from "../../../../lib/security/rate-limit";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../lib/security/request-body-limit";
import { enforceTurnstileIfRequired } from "../../../../lib/security/turnstile";
import {
  isMfaRequired,
  resolveChallengeTtlSec
} from "../../../../lib/auth/mfa-config";
import {
  createMfaChallenge,
  findActiveMfaFactor
} from "../../../../modules/identity-access/application/mfa";
import { recordAuditEvent } from "../../../../modules/logging/application/audit-log";
import {
  hashClientIp,
  summarizeUserAgent
} from "../../../../lib/security/client-fingerprint";
import { log } from "../../../../lib/logging/logger";
import { isSsoRequired } from "../../../../lib/auth/sso-config";
import { isPasswordLoginDisabledForIdentity } from "../../../../modules/identity-access/application/tenant-auth-policy";
import type { LoginDenyReason } from "../../../../modules/identity-access/domain/login-policy";

const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 5);
const LOCKOUT_MINUTES = 15;
const SESSION_TTL_MIN = Number(process.env.AUTH_SESSION_TTL_MIN ?? 120);

/**
 * Source-scoped volumetric rate limit (Issue #437), complementary to the
 * per-identity lockout above: `evaluateLoginAttempt`'s `failed_login_count`
 * only ever trips for repeated attempts against the *same* identity, so an
 * attacker rotating `loginIdentifier` values against the same tenant from
 * the same source never crosses it. This is a much looser ceiling (higher
 * than `MAX_FAILED_ATTEMPTS`) so it never fires for a legitimate user
 * simply mistyping their password a few times — it exists to bound request
 * *volume* (this endpoint runs an argon2id verify, doc 20's "Denial of
 * service" STRIDE row) and cross-identity enumeration, not to replace the
 * account lockout.
 */
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = Number(
  process.env.AUTH_LOGIN_RATE_LIMIT_MAX ?? 20
);
const LOGIN_RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC ?? 60
);

type LoginBody = {
  loginIdentifier?: unknown;
  password?: unknown;
  turnstileToken?: unknown;
};

/**
 * Issue #821 — source attribution shared by the `login_succeeded` and
 * `login_failed` audit rows below.
 *
 * `loginIdentifier` is deliberately NOT part of this: it is typically an
 * email address (PII, and one that `redactSensitiveAttributes` would *not*
 * catch under that key name), and persisting the attacker-supplied string on
 * a failed attempt is exactly the user-enumeration leak this issue asks to
 * avoid. `password` is likewise never referenced here — the only inputs that
 * reach an audit attribute are the source fingerprint and the policy's own
 * deny reason.
 */
type LoginAuditContext = {
  ipHash: string;
  userAgent?: string;
};

function buildLoginAuditContext(
  request: Request,
  clientIp: string
): LoginAuditContext {
  return {
    ipHash: hashClientIp(clientIp),
    userAgent: summarizeUserAgent(request)
  };
}

/**
 * Every `evaluateLoginAttempt` deny reason, plus `"internal_error"` for the
 * one failure the policy layer cannot describe: the login transaction threw
 * and was rolled back (see `recordLoginFailureOutOfBand`).
 */
type LoginAuditFailureReason = LoginDenyReason | "internal_error";

/**
 * Records one `login_failed` audit row.
 *
 * `reason` is the `evaluateLoginAttempt` deny reason verbatim, which is
 * already collapsed at the policy layer: an unknown `loginIdentifier`, a
 * wrong password, an inactive identity, and an inactive tenant-user all
 * return the single reason `"invalid_credentials"` (see
 * `login-policy.ts`) — so the reason alone never distinguishes "this account
 * does not exist" from "this account exists and the password was wrong".
 *
 * `resourceId` IS set when the identity resolved, and that is intentional:
 * `awcms_mini_audit_events` is tenant-scoped and RLS-protected, readable only
 * by operators who can already read `awcms_mini_identities` directly, so it
 * discloses nothing they don't already hold — while omitting it would strip
 * the trail of the one field that answers "which account is being attacked?",
 * defeating the purpose of auditing failures at all. The enumeration
 * guarantee this issue asks for is about what an *unauthenticated caller* can
 * infer, and setting `resourceId` here does not affect that either way: the
 * audit row is never part of a response.
 *
 * That is deliberately NOT a claim that the responses below are
 * indistinguishable — they are not, and this comment used to say they were
 * (PR #839 security review). Two branches, both reachable only once the
 * identity has resolved, are observably different from the
 * `"Invalid login identifier or password."` 401 an unknown identifier gets:
 * `locked` answers 401 with `"Account is temporarily locked."`, and
 * `password_login_disabled` answers 403. An unauthenticated caller can
 * therefore still infer that a given identifier exists. That oracle predates
 * this change and is tracked separately in Issue #840 (the `fail()` calls it
 * concerns are deliberately untouched here); do not read this comment as
 * evidence it is closed.
 */
async function recordLoginFailure(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    identityId?: string;
    reason: LoginAuditFailureReason;
    audit: LoginAuditContext;
    correlationId?: string;
  }
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId: input.tenantId,
    moduleKey: "identity_access",
    action: "login_failed",
    resourceType: "identity",
    resourceId: input.identityId,
    severity: "warning",
    message: `Password sign-in failed: ${input.reason}.`,
    attributes: {
      method: "password",
      reason: input.reason,
      ...input.audit
    },
    correlationId: input.correlationId
  });
}

/**
 * Issue #821 — records `login_failed` in a FRESH transaction, for the case
 * where the login transaction itself threw and was rolled back, taking any
 * audit row written inside it along with it.
 *
 * Reached only on an exception, never on an ordinary authentication denial
 * (those `return` and commit with `recordLoginFailure` above), so this never
 * doubles the connection cost of a brute-force attempt against this public,
 * unauthenticated endpoint — which is exactly why the normal deny path is not
 * routed through here as well.
 *
 * Strictly best-effort: whatever unwound the login transaction was very
 * plausibly the database itself, in which case this write cannot succeed
 * either. Its own failure is swallowed and logged so it can never mask the
 * original error, which is rethrown by the caller. The raw exception is never
 * handed to `log()` — see doc 20 §Issue #687: an exception message is
 * unkeyed free text that key-based redaction cannot clean.
 */
async function recordLoginFailureOutOfBand(
  sql: Bun.SQL,
  input: {
    tenantId: string;
    audit: LoginAuditContext;
    correlationId?: string;
  }
): Promise<void> {
  try {
    await withTenant(sql, input.tenantId, async (tx) => {
      await recordLoginFailure(tx, {
        tenantId: input.tenantId,
        reason: "internal_error",
        audit: input.audit,
        correlationId: input.correlationId
      });
    });
  } catch {
    log("warning", "auth.login.audit_write_failed", {
      moduleKey: "identity_access",
      tenantId: input.tenantId,
      correlationId: input.correlationId
    });
  }
}

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

  // Rate limit before touching the database or hashing anything (Issue
  // #437) — the cheapest possible rejection point for a volumetric attack
  // against this expensive, public endpoint. Keyed by source + tenant, not
  // by `loginIdentifier`, so it also catches an attacker rotating
  // identifiers to dodge the per-identity lockout below.
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = checkRateLimit(`${clientIp}:${tenantId}`, {
    maxAttempts: LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: LOGIN_RATE_LIMIT_WINDOW_SEC * 1000
  });

  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many login attempts from this source. Try again later.",
      {},
      undefined,
      { "retry-after": String(rateLimit.retryAfterSec) }
    );
  }

  const bodyRead = await readJsonBody<LoginBody>(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const body = bodyRead.value;

  if (
    !body ||
    typeof body.loginIdentifier !== "string" ||
    typeof body.password !== "string"
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "loginIdentifier and password are required."
    );
  }

  // Full-online-only (Issue #587/#588): a no-op on every local/offline/LAN
  // deployment (isTurnstileRequired() is false there), and cheaper than the
  // DB/password-hash work below when it does apply — verify before either.
  const turnstileResult = await enforceTurnstileIfRequired(
    body.turnstileToken,
    clientIp
  );

  if (!turnstileResult.ok) {
    return fail(
      400,
      turnstileResult.code,
      turnstileResult.code === "TURNSTILE_REQUIRED"
        ? "Turnstile verification token is required."
        : "Turnstile verification failed."
    );
  }

  const loginIdentifier = body.loginIdentifier;
  const password = body.password;
  const sql = getDatabaseClient();
  const now = new Date();
  const auditContext = buildLoginAuditContext(request, clientIp);

  return withTenant(sql, tenantId, async (tx) => {
    const tenantRows =
      await tx`SELECT status FROM awcms_mini_tenants WHERE id = ${tenantId}`;
    const tenantStatus = (tenantRows[0]?.status as string | undefined) ?? null;

    const identityRows = await tx`
      SELECT id, status, password_hash, failed_login_count, locked_until
      FROM awcms_mini_identities
      WHERE tenant_id = ${tenantId} AND login_identifier = ${loginIdentifier}
    `;
    const identityRow = identityRows[0] as
      | {
          id: string;
          status: "active" | "inactive" | "locked";
          password_hash: string;
          failed_login_count: number;
          locked_until: Date | null;
        }
      | undefined;

    const passwordMatches = identityRow
      ? await verifyPassword(password, identityRow.password_hash)
      : false;

    let tenantUserStatus: "active" | "inactive" | null = null;

    if (identityRow) {
      const tenantUserRows = await tx`
        SELECT status FROM awcms_mini_tenant_users
        WHERE tenant_id = ${tenantId} AND identity_id = ${identityRow.id}
      `;
      tenantUserStatus =
        (tenantUserRows[0]?.status as "active" | "inactive" | undefined) ??
        null;
    }

    // Full-online-only (Issue #587/#591): a no-op on every local/offline/LAN
    // deployment (isSsoRequired() is false there) and on every tenant that
    // has never configured a restrictive auth policy — only then is the
    // extra read even attempted, preserving today's login behavior exactly
    // everywhere else.
    const passwordLoginDisabled =
      identityRow && isSsoRequired()
        ? await isPasswordLoginDisabledForIdentity(tx, tenantId, identityRow.id)
        : false;

    const result = evaluateLoginAttempt({
      now,
      tenantStatus,
      identity: identityRow
        ? {
            status: identityRow.status,
            failedLoginCount: identityRow.failed_login_count,
            lockedUntil: identityRow.locked_until
          }
        : null,
      tenantUserStatus,
      passwordMatches,
      maxFailedAttempts: MAX_FAILED_ATTEMPTS,
      lockoutMinutes: LOCKOUT_MINUTES,
      passwordLoginDisabled
    });

    if (result.outcome === "deny") {
      if (identityRow && result.failedLoginCount !== undefined) {
        await tx`
          UPDATE awcms_mini_identities
          SET failed_login_count = ${result.failedLoginCount},
              locked_until = ${result.lockedUntil ?? null}
          WHERE id = ${identityRow.id}
        `;
      }

      // Written inside the same transaction as the `failed_login_count`
      // UPDATE above, and therefore committed with it: every deny path below
      // `return`s a response rather than throwing, so this transaction always
      // reaches COMMIT (the lockout counter's durability across the exact same
      // boundary is what the account-lockout feature has always depended on).
      // The out-of-band recorder in the `catch` at the bottom of this handler
      // covers the remaining case — an exception unwinding this transaction
      // before it commits.
      await recordLoginFailure(tx, {
        tenantId,
        identityId: identityRow?.id,
        reason: result.reason,
        audit: auditContext,
        correlationId: locals.correlationId
      });

      if (result.reason === "tenant_inactive") {
        return fail(403, "ACCESS_DENIED", "Tenant is not active.");
      }

      if (result.reason === "locked") {
        return fail(
          401,
          "AUTH_INVALID_CREDENTIALS",
          "Account is temporarily locked."
        );
      }

      if (result.reason === "password_login_disabled") {
        return fail(
          403,
          "PASSWORD_LOGIN_DISABLED",
          "Password login is disabled for this account. Use single sign-on instead."
        );
      }

      return fail(
        401,
        "AUTH_INVALID_CREDENTIALS",
        "Invalid login identifier or password."
      );
    }

    // Full-online-only (Issue #587/#589): a no-op on every local/offline/LAN
    // deployment and for every identity that has never enrolled MFA (MFA is
    // opt-in per identity, not mandatory tenant-wide, even when the feature
    // is enabled). Checked AFTER password verification succeeds but BEFORE
    // any session is created — a password-valid login with an active MFA
    // factor must never receive a session, only a challenge.
    if (isMfaRequired()) {
      const factor = await findActiveMfaFactor(tx, tenantId, identityRow!.id);

      if (factor) {
        await tx`
          UPDATE awcms_mini_identities
          SET failed_login_count = 0
          WHERE id = ${identityRow!.id}
        `;

        const challenge = await createMfaChallenge(
          tx,
          tenantId,
          identityRow!.id,
          resolveChallengeTtlSec(),
          now
        );

        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: "identity_access",
          action: "mfa_challenge_issued",
          resourceType: "identity",
          resourceId: identityRow!.id,
          severity: "info",
          message: "Password verified; MFA challenge issued.",
          attributes: { method: "password", ...auditContext },
          correlationId: locals.correlationId
        });

        return fail(
          401,
          "MFA_REQUIRED",
          "Multi-factor authentication is required to complete sign-in.",
          {},
          {
            mfaChallengeToken: challenge.token,
            expiresAt: challenge.expiresAt.toISOString()
          }
        );
      }
    }

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MIN * 60_000);

    await tx`
      UPDATE awcms_mini_identities
      SET failed_login_count = 0, last_login_at = ${now}
      WHERE id = ${identityRow!.id}
    `;

    await tx`
      INSERT INTO awcms_mini_sessions (tenant_id, identity_id, token_hash, expires_at)
      VALUES (${tenantId}, ${identityRow!.id}, ${tokenHash}, ${expiresAt})
    `;

    // Issue #821 — `method: "password"` is unconditional here: this is the
    // only branch that mints a session directly from a password, and it is
    // reached only when no MFA challenge was issued above. The MFA and
    // OIDC/SSO completions mint their sessions in their own routes and audit
    // themselves (`mfa_challenge_verified`, `google_login_succeeded`,
    // `sso_login_succeeded`), so this row must never claim those methods.
    // Neither `token` nor `tokenHash` is referenced in the attributes.
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: "identity_access",
      action: "login_succeeded",
      resourceType: "identity",
      resourceId: identityRow!.id,
      severity: "info",
      message: "Password sign-in succeeded; session created.",
      attributes: { method: "password", ...auditContext },
      correlationId: locals.correlationId
    });

    // Additive (Issue 8.1): also set httpOnly + SameSite=Lax cookies so the
    // SSR admin shell (src/layouts/AdminLayout.astro) can authenticate
    // without exposing the raw session token to client-side JavaScript
    // (doc 15 §Autentikasi dan sesi). The JSON response body below is
    // unchanged for backward compatibility with existing bearer-token
    // clients/tests.
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
  }).catch(async (error: unknown) => {
    // Issue #821 — the login transaction was rolled back, so any `login_failed`
    // row `recordLoginFailure` wrote inside it is gone. Re-record it on a fresh
    // transaction, then rethrow untouched: this handler observes the failure
    // for the audit trail, it does not swallow or reshape it.
    await recordLoginFailureOutOfBand(sql, {
      tenantId,
      audit: auditContext,
      correlationId: locals.correlationId
    });

    throw error;
  });
};
