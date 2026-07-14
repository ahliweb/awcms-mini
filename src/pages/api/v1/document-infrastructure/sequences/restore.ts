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
import { restoreSequenceDefinition } from "../../../../../modules/document-infrastructure/application/document-number-sequence-definition-service";

const IDEMPOTENCY_SCOPE = "document_infrastructure_sequence_restore";

const RESTORE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "sequences",
  action: "restore" as const
};

/** `POST /api/v1/document-infrastructure/sequences/restore` (Issue #751) — reactivates the most recently closed definition for a scope by opening a NEW row carrying its format/counter forward. High-risk mutation: requires `Idempotency-Key`. */
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
  }>(request, "default");
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};

  const scope = {
    scopeType: typeof body.scopeType === "string" ? body.scopeType : "",
    scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
    sequenceKey: typeof body.sequenceKey === "string" ? body.sequenceKey : ""
  };

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
      RESTORE_GUARD
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

    const result = await restoreSequenceDefinition(
      tx,
      tenantId,
      auth.context.tenantUserId,
      scope,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(
          404,
          "NOT_FOUND",
          "No sequence definition history found for that scope/key."
        );
      }
      return fail(
        409,
        "ALREADY_ACTIVE",
        "A sequence definition is already active for that scope/key."
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
