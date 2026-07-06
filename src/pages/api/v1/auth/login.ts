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
};

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
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

  const body = (await request.json().catch(() => null)) as LoginBody | null;

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

  const loginIdentifier = body.loginIdentifier;
  const password = body.password;
  const sql = getDatabaseClient();
  const now = new Date();

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
      lockoutMinutes: LOCKOUT_MINUTES
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

      return fail(
        401,
        "AUTH_INVALID_CREDENTIALS",
        "Invalid login identifier or password."
      );
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
  });
};
