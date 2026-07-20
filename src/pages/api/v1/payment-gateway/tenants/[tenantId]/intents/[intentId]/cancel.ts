import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parseCancelSessionBody } from "../../../../../../../../modules/payment-gateway/application/request-parsing";
import { validateCancelSession } from "../../../../../../../../modules/payment-gateway/domain/request-validation";
import { cancelSession } from "../../../../../../../../modules/payment-gateway/application/payment-engine";
import {
  authorizeOperator,
  errorBody,
  isUuid,
  paymentFailureResponse,
  runIdempotentPaymentMutation,
  successBody
} from "../../../../_support";

const SCOPE = "payment_gateway_cancel_session";

/** `POST /.../intents/{intentId}/cancel` — cancel/expire a payment session (operator). */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const intentId = params.intentId ?? "";
  if (!isUuid(tenantId) || !isUuid(intentId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and intentId must be UUIDs."
    );
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const input = parseCancelSessionBody(raw);
  const errors = validateCancelSession(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "intents", "cancel");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    intentId,
    reason: input.reason,
    expectedVersion: input.expectedVersion
  });

  return runIdempotentPaymentMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await cancelSession(
        tx,
        tenantId,
        intentId,
        { reason: input.reason, expectedVersion: input.expectedVersion },
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
          body: successBody({ intent: result.intent })
        };
      }
      const mapped = paymentFailureResponse(result.reason);
      return {
        kind: "conflict",
        status: mapped.status,
        body: errorBody(mapped.code, result.message)
      };
    }
  );
};
