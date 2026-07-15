import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../modules/identity-access/application/access-guard";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../modules/_shared/idempotency";
import { revokeBusinessScopeAssignment } from "../../../../../../../modules/identity-access/application/business-scope-assignment-service";

const IDEMPOTENCY_SCOPE = "identity_access_business_scope_assignment_revoke";

type RevokeAssignmentBody = {
  revokeReason?: unknown;
};

/** `POST /api/v1/identity/business-scope/assignments/{id}/revoke` (Issue #746) — revoke an active business-scope assignment. High-risk mutation: requires `Idempotency-Key`, reason-required, audited `critical`. */
export const POST: APIRoute = async ({ request, cookies, locals, params }) => {
  const assignmentId = params.id;
  if (!assignmentId) {
    return fail(400, "VALIDATION_ERROR", "Assignment id is required.");
  }

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

  let body: RevokeAssignmentBody;
  try {
    body = (await request.json()) as RevokeAssignmentBody;
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }

  const revokeReason =
    typeof body.revokeReason === "string" ? body.revokeReason : "";
  const requestHash = computeRequestHash({
    ...body,
    id: assignmentId,
    action: "revoke"
  });
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    // Pre-fetch the target row's scope so the SoD chokepoint
    // (`high-risk-sod-guard.ts`) can correlate a `"same_scope_only"` rule
    // against the SUBJECT's other assignments at this exact scope — a
    // plain tenant-scoped read (RLS still applies via `withTenant`'s
    // `SET LOCAL`), not itself an authorization decision; `not_found` is
    // still reported normally below via the service's own lookup.
    const targetRows = (await tx`
      SELECT scope_type, scope_id FROM awcms_mini_business_scope_assignments
      WHERE tenant_id = ${tenantId} AND id = ${assignmentId}
    `) as { scope_type: string; scope_id: string }[];
    const target = targetRows[0];

    const auth = await authorizeInTransaction(tx, tenantId, tokenHash, now, {
      moduleKey: "identity_access",
      activityCode: "business_scope_assignments",
      action: "revoke",
      resourceAttributes: target
        ? { sodScopeType: target.scope_type, sodScopeId: target.scope_id }
        : undefined
    });

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

    const result = await revokeBusinessScopeAssignment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      assignmentId,
      { revokeReason },
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "validation") {
        return fail(
          400,
          "VALIDATION_ERROR",
          result.errors
            .map((error) => `${error.field}: ${error.message}`)
            .join("; ")
        );
      }
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Business-scope assignment not found.");
      }
      return fail(
        409,
        "ALREADY_REVOKED",
        "Business-scope assignment is not active."
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
