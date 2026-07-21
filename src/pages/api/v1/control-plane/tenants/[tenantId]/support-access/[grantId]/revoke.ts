import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { revokeSupportAccess } from "../../../../../../../../modules/identity-access/application/support-access";
import {
  authorizeSupportOperator,
  isUuid,
  successBody,
  withTargetTenant
} from "../../../../_support";

/**
 * `POST /.../support-access/{grantId}/revoke` — revoke an active grant before its
 * expiry (high-risk `revoke`). After this, the operator's cross-tenant reads for
 * this tenant fail closed immediately.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const grantId = params.grantId ?? "";
  if (!isUuid(tenantId) || !isUuid(grantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId and grantId must be UUIDs.");
  }
  const auth = await authorizeSupportOperator(request, cookies, "revoke");
  if (auth instanceof Response) return auth;

  const result = await withTargetTenant(tenantId, (tx) =>
    revokeSupportAccess(tx, tenantId, grantId, {
      revokerTenantUserId: auth.actorTenantUserId,
      correlationId: locals.correlationId
    })
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return fail(status, "SUPPORT_ACCESS_CONFLICT", result.message);
  }
  return new Response(
    JSON.stringify(successBody({ grantId, status: "revoked" })),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
