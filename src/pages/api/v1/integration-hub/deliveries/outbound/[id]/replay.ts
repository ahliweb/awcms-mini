import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { withTenant } from "../../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../modules/_shared/idempotency";
import { readJsonBody } from "../../../../../../../lib/security/request-body-limit";
import { recordAuditEvent } from "../../../../../../../modules/logging/application/audit-log";
import {
  DeliveryNotFoundError,
  DeliveryNotReplayableError,
  replayOutboundDelivery
} from "../../../../../../../modules/integration-hub/application/delivery-replay";

const REPLAY_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "deliveries",
  action: "replay" as const
};
const IDEMPOTENCY_SCOPE = "integration_hub_outbound_delivery_replay";
const MAX_REASON_LENGTH = 500;

type ReplayRequestBody = { reason?: unknown };

/**
 * `POST /api/v1/integration-hub/deliveries/outbound/{id}/replay` (Issue
 * #754) — permission-gated (`deliveries.replay`), reason-required,
 * `Idempotency-Key`-required, audited. Only valid from a `dead_letter`
 * delivery. Creates a NEW delivery row (`replay_of_delivery_id`) rather
 * than mutating the original — see `application/delivery-replay.ts`'s doc
 * comment for why this cannot risk double-processing the same underlying
 * source event.
 */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Delivery id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<ReplayRequestBody>(request);
  if (bodyRead.tooLarge)
    return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  const reason =
    typeof bodyRead.value?.reason === "string"
      ? bodyRead.value.reason.trim()
      : "";
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `reason is required and must be 1-${MAX_REASON_LENGTH} characters.`
    );
  }

  const requestHash = computeRequestHash({ id, action: "replay", reason });
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
      REPLAY_GUARD
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

    let replayed;

    try {
      replayed = await replayOutboundDelivery(tx, tenantId, id);
    } catch (error) {
      if (error instanceof DeliveryNotFoundError) {
        return fail(404, "RESOURCE_NOT_FOUND", error.message);
      }

      if (error instanceof DeliveryNotReplayableError) {
        return fail(409, "INVALID_STATUS_TRANSITION", error.message);
      }

      throw error;
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.outbound_delivery.replayed",
      resourceType: "integration_outbound_delivery",
      resourceId: replayed.originalDeliveryId,
      severity: "info",
      message: `Outbound delivery replayed (new delivery ${replayed.newDeliveryId}): ${reason}`,
      correlationId
    });

    const successResponse = ok({ newDeliveryId: replayed.newDeliveryId });
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
