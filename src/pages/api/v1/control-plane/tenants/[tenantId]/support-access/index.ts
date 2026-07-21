import type { APIRoute } from "astro";

import { fail } from "../../../../../../../modules/_shared/api-response";
import {
  listSupportGrants,
  requestSupportAccess
} from "../../../../../../../modules/identity-access/application/support-access";
import {
  authorizeSupportOperator,
  isUuid,
  successBody,
  withTargetTenant
} from "../../../_support";

/** `GET /.../tenants/{tenantId}/support-access` — list support grants (audit). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }
  const auth = await authorizeSupportOperator(request, cookies, "read");
  if (auth instanceof Response) return auth;
  const grants = await withTargetTenant(tenantId, (tx) =>
    listSupportGrants(tx, tenantId)
  );
  return new Response(JSON.stringify(successBody({ grants })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

/**
 * `POST /.../tenants/{tenantId}/support-access` — MAKER: request a time/reason-
 * bound cross-tenant support-access grant for the requesting operator's identity.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }
  const auth = await authorizeSupportOperator(request, cookies, "request");
  if (auth instanceof Response) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const reason =
    raw &&
    typeof raw === "object" &&
    typeof (raw as { reason?: unknown }).reason === "string"
      ? (raw as { reason: string }).reason.trim()
      : "";
  if (reason.length < 1 || reason.length > 2000) {
    return fail(400, "VALIDATION_ERROR", "reason is required (1..2000 chars).");
  }

  const result = await withTargetTenant(tenantId, (tx) =>
    requestSupportAccess(tx, tenantId, {
      operatorIdentityId: auth.operatorIdentityId,
      reason,
      requestedBy: auth.actorTenantUserId,
      correlationId: locals.correlationId
    })
  );
  if (!result.ok) {
    return fail(409, "SUPPORT_ACCESS_CONFLICT", result.message);
  }
  return new Response(
    JSON.stringify(
      successBody({ grantId: result.grantId, status: "requested" })
    ),
    { status: 201, headers: { "content-type": "application/json" } }
  );
};
