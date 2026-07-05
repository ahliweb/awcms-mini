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

const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 5);
const LOCKOUT_MINUTES = 15;
const SESSION_TTL_MIN = Number(process.env.AUTH_SESSION_TTL_MIN ?? 120);

type LoginBody = {
  loginIdentifier?: unknown;
  password?: unknown;
};

export const POST: APIRoute = async ({ request }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
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

    return ok({ token, expiresAt: expiresAt.toISOString() });
  });
};
