import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { approveSupportAccess } from "../../../../../../../../modules/identity-access/application/support-access";
import {
  authorizeSupportOperator,
  isUuid,
  successBody,
  withTargetTenant
} from "../../../../_support";

// Bounded default/maximum grant lifetime (break-glass is exceptional and
// short-lived, ADR-0022 §6). Callers may shorten via `ttlSeconds`.
const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 86_400;

/**
 * `POST /.../support-access/{grantId}/approve` — CHECKER (high-risk `approve`).
 * The SoD chokepoint blocks any actor who also holds
 * `identity_access.support_access.request` (rule support_request_vs_approve), so
 * a grant is only ever activated by a SECOND, distinct actor. Step-up applies.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const grantId = params.grantId ?? "";
  if (!isUuid(tenantId) || !isUuid(grantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId and grantId must be UUIDs.");
  }
  const auth = await authorizeSupportOperator(request, cookies, "approve");
  if (auth instanceof Response) return auth;

  let ttlSeconds = DEFAULT_TTL_SECONDS;
  try {
    const raw = (await request.json()) as { ttlSeconds?: unknown };
    if (
      typeof raw?.ttlSeconds === "number" &&
      Number.isFinite(raw.ttlSeconds)
    ) {
      ttlSeconds = Math.max(
        1,
        Math.min(MAX_TTL_SECONDS, Math.floor(raw.ttlSeconds))
      );
    }
  } catch {
    // Empty/invalid body -> default TTL.
  }

  const result = await withTargetTenant(tenantId, (tx) =>
    approveSupportAccess(tx, tenantId, grantId, {
      approverTenantUserId: auth.actorTenantUserId,
      ttlSeconds,
      now: new Date(),
      correlationId: locals.correlationId
    })
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return fail(status, "SUPPORT_ACCESS_CONFLICT", result.message);
  }
  return new Response(
    JSON.stringify(
      successBody({ grantId, status: "approved", expiresAt: result.expiresAt })
    ),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
