import type { APIRoute } from "astro";
import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import { extractBearerToken } from "../../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../../modules/identity-access/domain/access-control";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { decideMergeRequest } from "../../../../../modules/profile-identity/application/merge-workflow";
import { validateMergeDecisionInput } from "../../../../../modules/profile-identity/domain/merge";

const GUARD_ACTIVITY = {
  moduleKey: "profile_identity",
  activityCode: "profile_merge"
};
const IDEMPOTENCY_SCOPE = "profile_identity_merge_request_decision";

/**
 * `POST /api/v1/profile-merge-requests/{id}/decisions` (Issue #748) — same
 * shape as `workflows/tasks/{id}/decisions.ts` (Issue 11.1): the merge
 * request's `requested_by` is looked up BEFORE calling `evaluateAccess` so
 * the existing generic self-approval guard in `access-control.ts`
 * (`request.action === "approve"` + `resourceAttributes.
 * requestedByTenantUserId`) can deny the requester approving their own
 * merge request. High-risk mutation: requires `Idempotency-Key`.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");
  const mergeRequestId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!mergeRequestId) {
    return fail(400, "VALIDATION_ERROR", "Merge request id is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const idempotencyKey = request.headers.get("idempotency-key");

  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateMergeDecisionInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Decision input is invalid.",
      {},
      validation.errors
    );
  }

  const { decision, reason } = validation.value;
  const requestHash = computeRequestHash({ mergeRequestId, decision, reason });
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

    if (!context) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const requestRows = await tx`
      SELECT requested_by FROM awcms_mini_profile_merge_requests
      WHERE tenant_id = ${tenantId} AND id = ${mergeRequestId}
    `;
    const requestedByTenantUserId = (
      requestRows[0] as { requested_by: string | null } | undefined
    )?.requested_by;

    const guardRequest = {
      ...GUARD_ACTIVITY,
      action: "approve" as const,
      resourceType: "profile_merge_request",
      resourceId: mergeRequestId,
      resourceAttributes: {
        tenantId,
        requestedByTenantUserId
      }
    };

    const decisionResult = evaluateAccess(
      context,
      guardRequest,
      await fetchGrantedPermissionKeys(tx, tenantId, context.tenantUserId)
    );

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      guardRequest,
      decisionResult
    );

    if (!decisionResult.allowed) {
      return fail(403, "ACCESS_DENIED", decisionResult.reason);
    }

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
    );

    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }

      return jsonResponse(existingIdempotency.responseBody, {
        status: existingIdempotency.responseStatus
      });
    }

    const result = await decideMergeRequest(
      tx,
      tenantId,
      context.tenantUserId,
      mergeRequestId,
      decision,
      reason,
      correlationId
    );

    if (result.outcome === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Merge request not found.");
    }

    if (result.outcome === "already_decided") {
      return fail(
        409,
        "MERGE_REQUEST_ALREADY_DECIDED",
        `Merge request is already ${result.view.status}.`
      );
    }

    const successResponse = ok(result.view);
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
