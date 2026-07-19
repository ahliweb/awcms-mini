import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { listModules } from "../../../../../modules";
import { createServiceCatalogReadPort } from "../../../../../modules/service-catalog/application/service-catalog-read-port-adapter";
import { transitionAssignment } from "../../../../../modules/tenant-entitlement/application/entitlement-directory";
import {
  requiredActionForTransition,
  type AssignmentTransitionStatus
} from "../../../../../modules/tenant-entitlement/domain/entitlement";
import { parseTransitionBody } from "../../../../../modules/tenant-entitlement/application/request-parsing";

const IDEMPOTENCY_SCOPE = "tenant_entitlement_transition";

const TRANSITION_STATUSES: readonly AssignmentTransitionStatus[] = [
  "active",
  "suspended",
  "canceled"
];

/**
 * `PATCH /api/v1/tenant-entitlement/assignments/{assignmentId}` (Issue #871) —
 * transition an assignment's lifecycle: suspend/resume (`update`) or cancel
 * (`revoke`, entitlement loss — data preserved). The required permission is
 * DERIVED from the requested transition (`requiredActionForTransition`), so
 * cancel is gated by the high-risk `revoke` action and suspend/resume by
 * `update` — default-deny holds either way. High-risk: requires
 * `Idempotency-Key`, emits `assignment.changed`, and is audited.
 */
export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const assignmentId = params.assignmentId ?? "";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const transition = parseTransitionBody(body);
  if (!TRANSITION_STATUSES.includes(transition.status)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `status must be one of: ${TRANSITION_STATUSES.join(", ")}.`
    );
  }
  // A cancel/suspend must carry a reason (auditable, reason-bound).
  if (transition.status !== "active" && (transition.reason ?? "").length < 1) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "reason is required to suspend or cancel an assignment."
    );
  }

  const guard = {
    moduleKey: "tenant_entitlement",
    activityCode: "assignments",
    action: requiredActionForTransition(transition.status)
  };
  const requestHash = computeRequestHash({
    assignmentId,
    status: transition.status,
    reason: transition.reason
  });

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      guard
    );
    if (!auth.allowed) return auth.denied;

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    const deps = {
      catalogPort: createServiceCatalogReadPort(tx),
      moduleDescriptors: listModules()
    };
    const result = await transitionAssignment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      assignmentId,
      transition.status,
      transition.reason,
      deps,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Assignment not found.");
      }
      if (result.reason === "invalid_transition") {
        return fail(409, "VALIDATION_ERROR", result.message);
      }
      // conflict: a concurrent transition won. Replay a same-key winner if any.
      const replay = await replayConcurrentIdempotentWinner(
        tx,
        tenantId,
        IDEMPOTENCY_SCOPE,
        idempotencyKey,
        requestHash
      );
      if (replay) {
        return jsonResponse(replay.responseBody, {
          status: replay.responseStatus
        });
      }
      return fail(
        409,
        "VALIDATION_ERROR",
        "This assignment was concurrently transitioned."
      );
    }

    const successResponse = ok({ assignment: result.assignment });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  });
};
