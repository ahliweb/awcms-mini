import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { resolveClientIp } from "../../../../lib/security/rate-limit";
import { enforceTurnstileIfRequired } from "../../../../lib/security/turnstile";
import { validateSetupInitializeInput } from "../../../../modules/tenant-admin/domain/setup-validation";
import { bootstrapPlatformTenant } from "../../../../modules/tenant-admin/application/platform-bootstrap";

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const body = await request.json().catch(() => null);
  const validation = validateSetupInitializeInput(body);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Setup input is invalid.",
      {},
      validation.errors
    );
  }

  // Full-online-only (Issue #587/#588): a no-op on every local/offline/LAN
  // deployment, and cheaper than the multi-row tenant/owner INSERT sequence
  // below when it does apply — verify before either. Setup is a once-only,
  // singleton-locked endpoint (see the `ON CONFLICT DO NOTHING` claim below),
  // but still worth gating: an attacker racing this endpoint before a real
  // operator completes setup is exactly the kind of public, unauthenticated,
  // high-value target Turnstile exists for.
  const turnstileResult = await enforceTurnstileIfRequired(
    (body as Record<string, unknown> | null)?.turnstileToken,
    resolveClientIp(request, clientAddress)
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

  const input = validation.value;
  const sql = getDatabaseClient();

  return sql.begin(async (tx) => {
    const result = await bootstrapPlatformTenant(tx, input);

    if (result.outcome === "already_initialized") {
      return fail(403, "ACCESS_DENIED", "Setup has already been completed.");
    }

    return ok({
      tenantId: result.tenantId,
      officeId: result.officeId,
      ownerProfileId: result.ownerProfileId,
      ownerIdentityId: result.ownerIdentityId,
      ownerTenantUserId: result.ownerTenantUserId,
      ownerRoleId: result.ownerRoleId
    });
  });
};
