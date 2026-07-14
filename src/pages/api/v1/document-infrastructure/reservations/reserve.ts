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
import { reserveNumber } from "../../../../../modules/document-infrastructure/application/document-number-reservation-service";

const IDEMPOTENCY_SCOPE = "document_infrastructure_number_reserve";

const RESERVE_GUARD = {
  moduleKey: "document_infrastructure",
  activityCode: "reservations",
  action: "reserve" as const
};

/**
 * `POST /api/v1/document-infrastructure/reservations/reserve` (Issue
 * #751) — atomically reserves the next number from a sequence (`SELECT
 * ... FOR UPDATE` on the sequence's current definition row, see
 * `application/document-number-reservation-service.ts`'s own header).
 * High-risk mutation: requires `Idempotency-Key` — CRITICAL here: a
 * network retry with the SAME key must replay the SAME reservation, not
 * allocate a second number.
 */
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

  if (!scope.scopeType || !scope.sequenceKey) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "scopeType and sequenceKey are required."
    );
  }

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
      RESERVE_GUARD
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

    const result = await reserveNumber(
      tx,
      tenantId,
      auth.context.tenantUserId,
      scope,
      correlationId
    );

    if (!result.ok) {
      return fail(
        404,
        "SEQUENCE_NOT_FOUND",
        "No active sequence definition found for that scope/key."
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
