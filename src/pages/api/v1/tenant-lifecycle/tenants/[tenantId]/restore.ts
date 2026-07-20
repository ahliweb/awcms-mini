import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../modules/_shared/idempotency";
import { parseRestoreBody } from "../../../../../../modules/tenant-lifecycle/application/request-parsing";
import { validateRestore } from "../../../../../../modules/tenant-lifecycle/domain/request-validation";
import { restore } from "../../../../../../modules/tenant-lifecycle/application/lifecycle-transition";
import {
  authorizeOperator,
  buildEngineDeps,
  errorBody,
  isUuid,
  lifecycleFailureResponse,
  runIdempotentLifecycleMutation,
  successBody
} from "../../_support";

const SCOPE = "tenant_lifecycle_restore";

/**
 * `POST /api/v1/tenant-lifecycle/tenants/{tenantId}/restore` (Issue #873) —
 * restore/reactivate a suspended/canceled/blocked tenant WITH reconciliation
 * against provisioning readiness (#872). An unresolved provisioning/payment
 * state must be EXPLICITLY confirmed (`confirmUnresolved`) or the restore is
 * refused (409) — never silently overlooked. Never deletes data. Platform-
 * operator only; mandatory `reason`; separately authorized (`states.restore`);
 * requires `Idempotency-Key`.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const targetTenantId = params.tenantId ?? "";
  if (!isUuid(targetTenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const input = parseRestoreBody(raw);
  const errors = validateRestore(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }

  const correlationId = locals.correlationId;
  const auth = await authorizeOperator(
    request,
    cookies,
    "states",
    "restore",
    correlationId
  );
  if (auth instanceof Response) return auth;

  const requestHash = computeRequestHash({
    tenantId: targetTenantId,
    action: "restore",
    reason: input.reason,
    confirmUnresolved: input.confirmUnresolved,
    expectedVersion: input.expectedVersion
  });
  const deps = buildEngineDeps(correlationId);
  return runIdempotentLifecycleMutation(
    targetTenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await restore(
        tx,
        targetTenantId,
        {
          reason: input.reason,
          confirmUnresolved: input.confirmUnresolved,
          expectedVersion: input.expectedVersion
        },
        deps,
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
          body: successBody({ lifecycle: result.state })
        };
      }
      const mapped = lifecycleFailureResponse(result.reason);
      return {
        kind: "conflict",
        status: mapped.status,
        body: errorBody(mapped.code, result.message)
      };
    }
  );
};
