import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { commitReservation } from "../../../../../../modules/document-infrastructure/application/document-number-reservation-service";

const IDEMPOTENCY_SCOPE = "document_infrastructure_number_commit";

const COMMIT_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "reservations",
  action: "commit" as const
};

/** `POST /api/v1/document-infrastructure/reservations/{id}/commit` (Issue #751) — commits a reserved number to a document. High-risk mutation: requires `Idempotency-Key`. */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const reservationId = params.id;
  if (!reservationId)
    return fail(400, "VALIDATION_ERROR", "Reservation id is required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<{ documentId?: unknown }>(
    request,
    "default"
  );
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = bodyRead.value ?? {};
  const documentId = typeof body.documentId === "string" ? body.documentId : "";

  if (!documentId) {
    return fail(400, "VALIDATION_ERROR", "documentId is required.");
  }

  const requestHash = computeRequestHash({
    ...body,
    id: reservationId,
    action: "commit"
  });
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
      COMMIT_GUARD
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

    const result = await commitReservation(
      tx,
      tenantId,
      auth.context.tenantUserId,
      reservationId,
      documentId,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(404, "NOT_FOUND", "Reservation not found.");
      }
      if (result.reason === "document_not_found") {
        return fail(
          422,
          "DOCUMENT_INVALID",
          "documentId does not reference an existing document for this tenant."
        );
      }
      return fail(
        409,
        "NOT_RESERVED",
        "Reservation is not in a reserved state (already committed or canceled)."
      );
    }

    const successResponse = ok({ reservation: result.reservation });
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
