import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../modules/_shared/idempotency";
import {
  parseCancelScheduleBody,
  parseScheduleBody
} from "../../../../../../modules/tenant-lifecycle/application/request-parsing";
import { validateSchedule } from "../../../../../../modules/tenant-lifecycle/domain/request-validation";
import {
  cancelSchedule,
  scheduleTransition
} from "../../../../../../modules/tenant-lifecycle/application/lifecycle-transition";
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

const SET_SCOPE = "tenant_lifecycle_schedule_set";
const CANCEL_SCOPE = "tenant_lifecycle_schedule_cancel";

/**
 * `POST /api/v1/tenant-lifecycle/tenants/{tenantId}/schedule` (Issue #873) —
 * schedule a future transition (trial/grace expiry) applied idempotently by the
 * scheduler. Platform-operator only; mandatory `reason`; requires
 * `Idempotency-Key`.
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
  const input = parseScheduleBody(raw);
  const errors = validateSchedule(input);
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
    "schedule",
    correlationId
  );
  if (auth instanceof Response) return auth;

  const requestHash = computeRequestHash({
    tenantId: targetTenantId,
    toState: input.toState,
    at: input.at,
    reason: input.reason,
    expectedVersion: input.expectedVersion
  });
  const deps = buildEngineDeps(correlationId);
  return runIdempotentLifecycleMutation(
    targetTenantId,
    SET_SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await scheduleTransition(
        tx,
        targetTenantId,
        {
          toState: input.toState as LifecycleState,
          at: input.at,
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

/**
 * `DELETE /api/v1/tenant-lifecycle/tenants/{tenantId}/schedule` (Issue #873) —
 * cancel the pending scheduled transition. Platform-operator only; mandatory
 * `reason`; requires `Idempotency-Key`.
 */
export const DELETE: APIRoute = async ({
  request,
  cookies,
  params,
  locals
}) => {
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
  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const input = parseCancelScheduleBody(raw);
  if (input.reason.trim().length < 1 || input.reason.length > 2000) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "reason: reason is required (1..2000 chars)."
    );
  }

  const correlationId = locals.correlationId;
  const auth = await authorizeOperator(
    request,
    cookies,
    "states",
    "schedule",
    correlationId
  );
  if (auth instanceof Response) return auth;

  const requestHash = computeRequestHash({
    tenantId: targetTenantId,
    action: "cancel_schedule",
    reason: input.reason,
    expectedVersion: input.expectedVersion
  });
  return runIdempotentLifecycleMutation(
    targetTenantId,
    CANCEL_SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await cancelSchedule(
        tx,
        targetTenantId,
        { reason: input.reason, expectedVersion: input.expectedVersion },
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
