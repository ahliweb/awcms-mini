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
import { requestPasswordReset } from "../../../../../modules/identity-access/application/password-reset";
import { validateForgotIdentifierInput } from "../../../../../modules/identity-access/domain/password-reset-validation";

const TOKEN_TTL_MIN = Number(
  process.env.AUTH_PASSWORD_RESET_TOKEN_TTL_MIN ?? 30
);
const RATE_LIMIT_MAX_ATTEMPTS = Number(
  process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX ?? 5
);
const RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC ?? 900
);

const GENERIC_MESSAGE =
  "If an account exists for that identifier, password reset instructions have been sent.";

/**
 * `POST /api/v1/auth/password/forgot` (Issue #496). Account-enumeration-safe
 * by construction: always returns the exact same 200 response regardless of
 * whether `loginIdentifier` matched an active, eligible identity — mirrors
 * `login.ts`'s "generalize the deny reason" precedent
 * (`identity-access/README.md`), just applied to a 200 response instead of
 * a 401. The audit event (unlike the response) DOES record whether a real
 * identity was found — audit logs are a restricted-access internal
 * surface, not user-facing, so recording this is valuable for detecting
 * enumeration/abuse patterns without weakening the public response.
 */
export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  // Rate limit before touching the database (same "cheapest rejection
  // point first" convention as login.ts, Issue #437) — this endpoint is
  // public, unauthenticated, and triggers a DB write + email enqueue.
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = checkRateLimit(`${clientIp}:${tenantId}:password-forgot`, {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_SEC * 1000
  });

  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many password reset requests from this source. Try again later.",
      {},
      undefined,
      { "retry-after": String(rateLimit.retryAfterSec) }
    );
  }

  const rawBody = await request.json().catch(() => null);
  const validation = validateForgotIdentifierInput(rawBody);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "loginIdentifier is required.",
      {},
      validation.errors
    );
  }

  // Full-online-only (Issue #587/#588): a no-op on every local/offline/LAN
  // deployment, and cheaper than the DB write + email enqueue below when it
  // does apply — verify before either.
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
  const appUrl = process.env.APP_URL ?? "http://localhost:4321";

  return withTenant(sql, tenantId, async (tx) => {
    const result = await requestPasswordReset(
      tx,
      tenantId,
      validation.value.loginIdentifier,
      now,
      {
        tokenTtlMinutes: TOKEN_TTL_MIN,
        resetUrlBase: `${appUrl}/reset-password`
      }
    );

    await recordAuditEvent(tx, {
      tenantId,
      // No `actorTenantUserId` — this is a self-service, unauthenticated
      // request; `result.identityId` is an identity id, not a tenant_user
      // id, so it belongs in `resourceId`/`attributes`, not that field.
      moduleKey: "identity_access",
      action: "password_reset_requested",
      resourceType: "identity",
      resourceId: result.identityId,
      severity: "info",
      message: result.enqueued
        ? "Password reset requested; email enqueued."
        : "Password reset requested for an unknown or ineligible identifier.",
      attributes: { identityFound: result.enqueued },
      correlationId
    });

    return ok({ requested: true, message: GENERIC_MESSAGE });
  });
};
