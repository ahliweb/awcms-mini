import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  checkRateLimit,
  resolveClientIp
} from "../../../../../lib/security/rate-limit";
import { enforceTurnstileIfRequired } from "../../../../../lib/security/turnstile";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import { completePasswordReset } from "../../../../../modules/identity-access/application/password-reset";
import { validateCompleteResetInput } from "../../../../../modules/identity-access/domain/password-reset-validation";

const RATE_LIMIT_MAX_ATTEMPTS = Number(
  process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX ?? 5
);
const RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC ?? 900
);

const GENERIC_INVALID_TOKEN_MESSAGE =
  "This password reset link is invalid or has expired.";

/**
 * `POST /api/v1/auth/password/reset` (Issue #496). The response never
 * distinguishes *why* a token was rejected (not found vs. expired vs.
 * already used) — same generic-error principle as `forgot.ts`'s generic
 * success, applied to the failure side, so a caller can't use this
 * endpoint to fingerprint token state. The audit event (internal-only)
 * does record the specific reason.
 */
export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  // Rate limit before touching the database — this endpoint lets a caller
  // guess at a valid token, so it must be bounded same as login's
  // credential-guessing surface.
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = checkRateLimit(`${clientIp}:${tenantId}:password-reset`, {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_SEC * 1000
  });

  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many password reset attempts from this source. Try again later.",
      {},
      undefined,
      { "retry-after": String(rateLimit.retryAfterSec) }
    );
  }

  const rawBody = await request.json().catch(() => null);
  const validation = validateCompleteResetInput(rawBody);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "token and newPassword are required.",
      {},
      validation.errors
    );
  }

  // Full-online-only (Issue #587/#588): a no-op on every local/offline/LAN
  // deployment, and cheaper than the password-hash + DB mutation below when
  // it does apply — verify before either.
  const turnstileResult = await enforceTurnstileIfRequired(
    (rawBody as Record<string, unknown> | null)?.turnstileToken,
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

  const sql = getDatabaseClient();
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const result = await completePasswordReset(
      tx,
      tenantId,
      validation.value.token,
      validation.value.newPassword,
      now
    );

    if (result.outcome === "invalid") {
      await recordAuditEvent(tx, {
        tenantId,
        moduleKey: "identity_access",
        action: "password_reset_failed",
        resourceType: "identity",
        severity: "warning",
        message: `Password reset attempt failed: ${result.reason}.`,
        attributes: { reason: result.reason },
        correlationId
      });

      return fail(400, "PASSWORD_RESET_INVALID", GENERIC_INVALID_TOKEN_MESSAGE);
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: "identity_access",
      action: "password_reset_completed",
      resourceType: "identity",
      resourceId: result.identityId,
      severity: "warning",
      message: "Password reset completed; sessions revoked.",
      correlationId
    });

    return ok({ reset: true });
  });
};
