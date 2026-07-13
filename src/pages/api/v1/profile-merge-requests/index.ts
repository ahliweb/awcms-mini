import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../modules/_shared/idempotency";
import {
  createMergeRequest,
  listMergeRequests,
  MergePartyNotFoundError
} from "../../../../modules/profile-identity/application/merge-workflow";
import {
  CrossTenantMergeError,
  validateCreateMergeRequestInput
} from "../../../../modules/profile-identity/domain/merge";

const READ_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "profile_merge",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "profile_identity",
  activityCode: "profile_merge",
  action: "create" as const
};

const IDEMPOTENCY_SCOPE = "profile_identity_merge_request_create";

const VALID_STATUSES = ["pending", "approved", "rejected", "completed"];

/**
 * `GET /api/v1/profile-merge-requests` (Issue #748) — separate top-level
 * path (not nested under `/profiles/`) so it never collides with
 * `/profiles/{id}`'s dynamic route segment. `?status=` optional filter.
 */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const statusParam = url.searchParams.get("status");

  if (statusParam !== null && !VALID_STATUSES.includes(statusParam)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `status must be one of: ${VALID_STATUSES.join(", ")}.`
    );
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      READ_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const items = await listMergeRequests(tx, tenantId, {
      status: statusParam ?? undefined
    });

    return ok({ items });
  });
};

/**
 * `POST /api/v1/profile-merge-requests` (Issue #748) — creates a merge
 * request (`sourceProfileId` is the loser, `targetProfileId` the
 * survivor). High-risk mutation: requires `Idempotency-Key`. Every merge
 * in this base requires a distinct approval decision before it can be
 * executed (`domain/merge.ts`'s `computeRequiresApproval`) — creating a
 * request never merges anything by itself. `409 PROFILE_MERGE_PARTY_NOT_FOUND`
 * if either profile does not exist, is already soft-deleted, is already
 * merged away, or belongs to a different tenant (cross-tenant merge is
 * strictly prohibited).
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
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

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateCreateMergeRequestInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Merge request input is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;
  const requestHash = computeRequestHash(input);
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
      CREATE_GUARD
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

    let mergeRequest;

    try {
      mergeRequest = await createMergeRequest(
        tx,
        tenantId,
        auth.context.tenantUserId,
        input,
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

    const successResponse = ok(mergeRequest);
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
