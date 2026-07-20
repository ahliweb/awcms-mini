import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import {
  parseRequestRefundBody,
  requestRefundIdempotencyFields
} from "../../../../../../../../modules/payment-gateway/application/request-parsing";
import { validateRequestRefund } from "../../../../../../../../modules/payment-gateway/domain/request-validation";
import { requestRefund } from "../../../../../../../../modules/payment-gateway/application/refund-engine";
import {
  authorizeOperator,
  authorizeRead,
  errorBody,
  isUuid,
  paymentFailureResponse,
  runIdempotentPaymentMutation,
  successBody,
  withTargetTenant
} from "../../../../_support";

const SCOPE = "payment_gateway_request_refund";

/** `GET /.../intents/{intentId}/refunds` — list refunds for an intent (operator or self-read). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  const intentId = params.intentId ?? "";
  if (!isUuid(tenantId) || !isUuid(intentId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and intentId must be UUIDs."
    );
  }
  const auth = await authorizeRead(request, cookies, tenantId, "refunds");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(
    tenantId,
    (tx) =>
      tx`
      SELECT id, intent_id, invoice_id, currency, amount_minor, status, version,
             provider_refund_ref, result_class, created_at
      FROM awcms_mini_payment_gateway_refunds
      WHERE tenant_id = ${tenantId} AND intent_id = ${intentId}
      ORDER BY created_at DESC
      LIMIT 200
    `
  );
  return new Response(JSON.stringify(successBody({ refunds: rows })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

/** `POST /.../intents/{intentId}/refunds` — request a refund (operator, mandatory reason, idempotent). */
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
  // Authorize BEFORE parsing/validating the body (consistent ordering, smaller
  // probing surface).
  const auth = await authorizeOperator(request, cookies, "refunds", "create");
  if (auth instanceof Response) return auth;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const input = parseRequestRefundBody(raw);
  const errors = validateRequestRefund(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash(
    requestRefundIdempotencyFields(tenantId, intentId, input)
  );

  return runIdempotentPaymentMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await requestRefund(
        tx,
        tenantId,
        intentId,
        { amountMinor: input.amountMinor, reason: input.reason },
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 201,
          body: successBody({ refund: result.refund })
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
