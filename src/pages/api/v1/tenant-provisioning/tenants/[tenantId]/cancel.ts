import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { parseCancelBody } from "../../../../../../modules/tenant-provisioning/application/request-parsing";
import { cancelProvisioning } from "../../../../../../modules/tenant-provisioning/application/provisioning-orchestrator";
import {
  authorizeOperator,
  buildEngineDeps,
  isUuid,
  newLeaseOwner,
  resolveRequestId
} from "../../_support";

/**
 * `POST /api/v1/tenant-provisioning/tenants/{tenantId}/cancel` (Issue #872) —
 * cancel a run when safe. Refuses if a worker holds a live lease (409); runs
 * classified compensation over completed steps (reversible undo / manual /
 * forbidden — NEVER a tenant-data delete); leaves the tenant inactive. Platform-
 * operator only. Requires `Idempotency-Key`.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const targetTenantId = params.tenantId ?? "";
  if (!isUuid(targetTenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }
  if (!request.headers.get("idempotency-key")) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const correlationId = locals.correlationId;
  const auth = await authorizeOperator(
    request,
    cookies,
    "requests",
    "cancel",
    correlationId
  );
  if (auth instanceof Response) return auth;

  let reason: string | null = null;
  try {
    reason = parseCancelBody(await request.json()).reason;
  } catch {
    reason = null;
  }

  const requestId = await resolveRequestId(targetTenantId);
  if (!requestId) {
    return fail(
      404,
      "RESOURCE_NOT_FOUND",
      "No provisioning run for this tenant."
    );
  }

  const sql = getDatabaseClient();
  const result = await cancelProvisioning(
    sql,
    targetTenantId,
    requestId,
    reason,
    {
      actorTenantUserId: auth.actorTenantUserId,
      correlationId,
      leaseOwner: newLeaseOwner()
    },
    buildEngineDeps(correlationId)
  );

  if (!result.ok) {
    if (result.reason === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Provisioning run not found.");
    }
    if (result.reason === "lease_conflict") {
      return fail(
        409,
        "PROVISIONING_LEASE_CONFLICT",
        "A provisioning worker is mid-step; retry cancel shortly."
      );
    }
    return fail(
      409,
      "PROVISIONING_NOT_CANCELABLE",
      `Provisioning run is ${result.status} and cannot be canceled.`
    );
  }

  return ok({ request: result.request });
};
