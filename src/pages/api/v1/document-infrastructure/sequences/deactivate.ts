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
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { deactivateSequenceDefinition } from "../../../../../modules/document-infrastructure/application/document-number-sequence-definition-service";

const IDEMPOTENCY_SCOPE = "document_infrastructure_sequence_deactivate";

const DELETE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "sequences",
  action: "delete" as const
};

/** `POST /api/v1/document-infrastructure/sequences/deactivate` (Issue #751) — closes the current open definition without opening a new one (no active definition remains). High-risk mutation: requires `Idempotency-Key`. */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
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

  const bodyRead = await readJsonBody<{
    scopeType?: unknown;
    scopeId?: unknown;
    sequenceKey?: unknown;
    deleteReason?: unknown;
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const scope = {
    scopeType: typeof body.scopeType === "string" ? body.scopeType : "",
    scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
    sequenceKey: typeof body.sequenceKey === "string" ? body.sequenceKey : ""
  };
  const deleteReason =
    typeof body.deleteReason === "string" ? body.deleteReason : "";

  const requestHash = computeRequestHash(body);
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
      DELETE_GUARD
    );
    if (!auth.allowed) return auth.denied;

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

    const result = await deactivateSequenceDefinition(
      tx,
      tenantId,
      auth.context.tenantUserId,
      scope,
      deleteReason,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(
          404,
          "NOT_FOUND",
          "No active sequence definition found for that scope/key."
        );
      }
      return fail(
        400,
        "VALIDATION_ERROR",
        result.errors
          .map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      );
    }

    const successResponse = ok({ sequence: result.sequence });
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
