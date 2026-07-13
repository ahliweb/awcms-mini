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
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import {
  executeMergeRequest,
  MergePartyNotFoundError
} from "../../../../../modules/profile-identity/application/merge-workflow";
import { CrossTenantMergeError } from "../../../../../modules/profile-identity/domain/merge";

const EXECUTE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "profile_merge",
  action: "merge" as const
};

const IDEMPOTENCY_SCOPE = "profile_identity_merge_request_execute";

/**
 * `POST /api/v1/profile-merge-requests/{id}/execute` (Issue #748) — the
 * REAL, state-changing merge operation. Requires the merge request to
 * already be `approved` (a separate, non-self decision via `.../
 * decisions`). High-risk mutation: `Idempotency-Key` required (defends
 * same-key double-submit) PLUS a `SELECT ... FOR UPDATE` row lock inside
 * `executeMergeRequest` itself (defends a second concurrent call with a
 * DIFFERENT idempotency key from double-executing the SAME merge
 * request — see that function's own header comment). Re-validates both
 * profiles belong to the caller's own tenant at execution time,
 * regardless of what the merge request said when it was created —
 * `403 CROSS_TENANT_MERGE_DENIED` if that check ever fires.
 */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const mergeRequestId = params.id;

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!mergeRequestId) {
    return fail(400, "VALIDATION_ERROR", "Merge request id is required.");
  }

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

  const requestHash = computeRequestHash({ mergeRequestId });
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      EXECUTE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
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

    let result;

    try {
      result = await executeMergeRequest(
        tx,
        tenantId,
        auth.context.tenantUserId,
        mergeRequestId,
        correlationId
      );
    } catch (error) {
      if (error instanceof MergePartyNotFoundError) {
        return fail(409, "PROFILE_MERGE_PARTY_NOT_FOUND", error.message);
      }

      if (error instanceof CrossTenantMergeError) {
        return fail(403, "CROSS_TENANT_MERGE_DENIED", error.message);
      }

      throw error;
    }

    if (result.outcome === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Merge request not found.");
    }

    if (result.outcome === "not_approved") {
      return fail(
        409,
        "MERGE_REQUEST_NOT_APPROVED",
        `Merge request must be approved before execution (current status: ${result.view.status}).`
      );
    }

    const responseBody =
      result.outcome === "already_executed"
        ? result.view
        : {
            ...result.view,
            entityLinksRepointedCount: result.entityLinksRepointedCount
          };

    const successResponse = ok(responseBody);
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
