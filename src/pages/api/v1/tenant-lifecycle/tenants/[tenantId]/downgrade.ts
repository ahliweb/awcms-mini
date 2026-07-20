import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../modules/_shared/idempotency";
import { parseDowngradeBody } from "../../../../../../modules/tenant-lifecycle/application/request-parsing";
import { validateDowngrade } from "../../../../../../modules/tenant-lifecycle/domain/request-validation";
import { downgrade } from "../../../../../../modules/tenant-lifecycle/application/lifecycle-transition";
import {
  authorizeOperator,
  buildEngineDeps,
  errorBody,
  isUuid,
  lifecycleFailureResponse,
  runIdempotentLifecycleMutation,
  successBody
} from "../../_support";

const SCOPE = "tenant_lifecycle_downgrade";

/**
 * `POST /api/v1/tenant-lifecycle/tenants/{tenantId}/downgrade` (Issue #873) —
 * downgrade the tenant's effective entitlement to a lower offer via the #871
 * contract WITHOUT changing lifecycle state and WITHOUT deleting any tenant data
 * (AC). Platform-operator only; mandatory `reason`; requires `Idempotency-Key`.
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
  const input = parseDowngradeBody(raw);
  const errors = validateDowngrade(input);
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
    "entitlement",
    "configure",
    correlationId
  );
  if (auth instanceof Response) return auth;

  const requestHash = computeRequestHash({
    tenantId: targetTenantId,
    offerPlanKey: input.offerPlanKey,
    offerVersion: input.offerVersion,
    expectedVersion: input.expectedVersion
  });
  const deps = buildEngineDeps(correlationId);
  return runIdempotentLifecycleMutation(
    targetTenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await downgrade(
        tx,
        targetTenantId,
        {
          offerPlanKey: input.offerPlanKey,
          offerVersion: input.offerVersion,
          reason: input.reason,
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
