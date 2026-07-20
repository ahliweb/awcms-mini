import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../modules/_shared/idempotency";
import { initializeLifecycle } from "../../../../../../modules/tenant-lifecycle/application/lifecycle-transition";
import {
  isLifecycleState,
  type LifecycleState
} from "../../../../../../modules/tenant-lifecycle/domain/lifecycle-state";
import {
  authorizeOperator,
  buildEngineDeps,
  isUuid,
  runIdempotentLifecycleMutation,
  successBody
} from "../../_support";

const SCOPE = "tenant_lifecycle_initialize";
const INITIAL_STATES: readonly LifecycleState[] = [
  "provisioning",
  "trial",
  "active"
];

/**
 * `POST /api/v1/tenant-lifecycle/tenants/{tenantId}/initialize` (Issue #873) —
 * create the tenant's lifecycle record at an initial state (provisioning/trial/
 * active). Idempotent (returns the existing record on repeat). Platform-operator
 * only; mandatory `reason`; requires `Idempotency-Key`.
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
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const initialState =
    typeof record.initialState === "string" ? record.initialState : "trial";
  const reason = typeof record.reason === "string" ? record.reason : "";
  if (
    !isLifecycleState(initialState) ||
    !INITIAL_STATES.includes(initialState)
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "initialState must be provisioning, trial, or active."
    );
  }
  if (reason.trim().length < 1 || reason.length > 2000) {
    return fail(400, "VALIDATION_ERROR", "reason is required (1..2000 chars).");
  }
  const trialEndsAt =
    typeof record.trialEndsAt === "string" ? record.trialEndsAt : null;
  const graceEndsAt =
    typeof record.graceEndsAt === "string" ? record.graceEndsAt : null;

  const correlationId = locals.correlationId;
  const auth = await authorizeOperator(
    request,
    cookies,
    "states",
    "update",
    correlationId
  );
  if (auth instanceof Response) return auth;

  // `reason` is part of the hash on EVERY lifecycle mutation (consistent
  // idempotency provenance): a same-key retry with a different reason is a
  // deterministic 409, never a silent replay.
  const requestHash = computeRequestHash({
    tenantId: targetTenantId,
    initialState,
    reason,
    trialEndsAt,
    graceEndsAt
  });

  const deps = buildEngineDeps(correlationId);
  return runIdempotentLifecycleMutation(
    targetTenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await initializeLifecycle(
        tx,
        targetTenantId,
        { initialState, reason, source: "operator", trialEndsAt, graceEndsAt },
        deps,
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      return {
        kind: "success",
        status: result.created ? 201 : 200,
        body: successBody({ lifecycle: result.state, created: result.created })
      };
    }
  );
};
