import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../modules/_shared/idempotency";
import { parseTransitionBody } from "../../../../../../modules/tenant-lifecycle/application/request-parsing";
import { validateTransition } from "../../../../../../modules/tenant-lifecycle/domain/request-validation";
import { transition } from "../../../../../../modules/tenant-lifecycle/application/lifecycle-transition";
import type {
  LifecycleSource,
  LifecycleState
} from "../../../../../../modules/tenant-lifecycle/domain/lifecycle-state";
import {
  authorizeOperator,
  buildEngineDeps,
  errorBody,
  isUuid,
  lifecycleFailureResponse,
  runIdempotentLifecycleMutation,
  successBody
} from "../../_support";

const SCOPE = "tenant_lifecycle_transition";

/**
 * `POST /api/v1/tenant-lifecycle/tenants/{tenantId}/transition` (Issue #873) —
 * perform a validated lifecycle transition (activate, suspend, past_due, grace,
 * cancel, block, ...). Platform-operator only; mandatory `reason`; requires
 * `Idempotency-Key`. Invalid transition / stale `expectedVersion` -> a
 * deterministic 409. Suspension propagates to public/worker via the projected
 * tenant status IN THE SAME COMMIT. Never deletes tenant data.
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
  const input = parseTransitionBody(raw);
  const errors = validateTransition(input);
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
    "update",
    correlationId
  );
  if (auth instanceof Response) return auth;

  // Resource-id-bound idempotency hash (target tenant + intended transition).
  const requestHash = computeRequestHash({
    tenantId: targetTenantId,
    toState: input.toState,
    reason: input.reason,
    source: input.source,
    expectedVersion: input.expectedVersion
  });

  const deps = buildEngineDeps(correlationId);
  return runIdempotentLifecycleMutation(
    targetTenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await transition(
        tx,
        targetTenantId,
        {
          toState: input.toState as LifecycleState,
          reason: input.reason,
          source: input.source as LifecycleSource,
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
