import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { runProvisioning } from "../../../../../../modules/tenant-provisioning/application/provisioning-orchestrator";
import {
  authorizeOperator,
  buildEngineDeps,
  isUuid,
  newLeaseOwner,
  resolveRequestId
} from "../../_support";

/**
 * `POST /api/v1/tenant-provisioning/tenants/{tenantId}/start` (Issue #872) —
 * start, resume, or retry a provisioning run from its durable checkpoint. Idem-
 * potent: acquires an exclusive lease (concurrent start → 409), runs each
 * remaining step in its own transaction, and re-runs a failed step within its
 * bounded attempt budget. Platform-operator only. Requires `Idempotency-Key`
 * (advisory — the lease + step checkpoints make the operation itself safe to
 * repeat).
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
    "retry",
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
  const result = await runProvisioning(
    sql,
    targetTenantId,
    requestId,
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
        "Another provisioning worker holds the lease for this run."
      );
    }
    return fail(
      409,
      "PROVISIONING_NOT_RESUMABLE",
      `Provisioning run is ${result.status} and cannot be resumed.`
    );
  }

  return ok({ request: result.request });
};
