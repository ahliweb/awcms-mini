import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { reconcileProvisioning } from "../../../../../../modules/tenant-provisioning/application/provisioning-orchestrator";
import { authorizeOperator, isUuid, resolveRequestId } from "../../_support";

/**
 * `POST /api/v1/tenant-provisioning/tenants/{tenantId}/reconcile` (Issue #872) —
 * a NON-DESTRUCTIVE desired-vs-actual reconciliation of a provisioned run. It
 * identifies drift and records safe operator actions — NEVER an auto-fix
 * (ADR-0022 §9). Platform-operator only. Requires `Idempotency-Key`.
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
    "reconciliation",
    "check",
    correlationId
  );
  if (auth instanceof Response) return auth;

  const requestId = await resolveRequestId(targetTenantId);
  if (!requestId) {
    return fail(
      404,
      "RESOURCE_NOT_FOUND",
      "No provisioning run for this tenant."
    );
  }

  const sql = getDatabaseClient();
  const result = await reconcileProvisioning(sql, targetTenantId, requestId, {
    actorTenantUserId: auth.actorTenantUserId,
    correlationId
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Provisioning run not found.");
    }
    return fail(
      409,
      "PROVISIONING_NOT_RECONCILABLE",
      `Provisioning run is ${result.status}; reconcile only a provisioned run.`
    );
  }

  return ok({
    status: result.status,
    drift: result.drift,
    request: result.request
  });
};
