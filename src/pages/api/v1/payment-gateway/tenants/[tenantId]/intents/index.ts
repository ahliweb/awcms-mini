import type { APIRoute } from "astro";

import { fail } from "../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../modules/_shared/idempotency";
import {
  initiateCheckoutIdempotencyFields,
  parseInitiateCheckoutBody
} from "../../../../../../../modules/payment-gateway/application/request-parsing";
import { validateInitiateCheckout } from "../../../../../../../modules/payment-gateway/domain/request-validation";
import { initiateCheckout } from "../../../../../../../modules/payment-gateway/application/payment-engine";
import {
  authorizeOperator,
  authorizeRead,
  errorBody,
  isUuid,
  paymentDeps,
  paymentFailureResponse,
  runIdempotentPaymentMutation,
  successBody,
  withTargetTenant
} from "../../../_support";

const SCOPE = "payment_gateway_initiate_checkout";

/** `GET /.../intents` — list payment intents (operator or self-read). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }
  const auth = await authorizeRead(request, cookies, tenantId, "intents");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(
    tenantId,
    (tx) =>
      tx`
      SELECT id, provider_account_id, provider_key, invoice_id, currency, amount_minor,
             status, version, provider_session_ref, expires_at, created_at
      FROM awcms_mini_payment_gateway_payment_intents
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 200
    `
  );
  return new Response(JSON.stringify(successBody({ intents: rows })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

/** `POST /.../intents` — initiate a hosted checkout session (operator, idempotent). */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
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
  const input = parseInitiateCheckoutBody(raw);
  const errors = validateInitiateCheckout(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "intents", "create");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash(
    initiateCheckoutIdempotencyFields(tenantId, input)
  );
  const expiresAt =
    input.expiresInMinutes !== null
      ? new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString()
      : null;

  return runIdempotentPaymentMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await initiateCheckout(
        tx,
        tenantId,
        {
          providerAccountId: input.providerAccountId,
          invoiceId: input.invoiceId,
          subscriptionId: input.subscriptionId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          expiresAt,
          reason: input.reason
        },
        paymentDeps(tx, tenantId),
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 201,
          body: successBody({ intent: result.intent })
        };
      }
      // Any failure is returned as a non-stored outcome (kind "conflict" also
      // covers 404/409): the idempotency layer replays a prior WINNER if one
      // exists, else returns this error as-is (never persisted as success).
      const mapped = paymentFailureResponse(result.reason);
      return {
        kind: "conflict",
        status: mapped.status,
        body: errorBody(mapped.code, result.message)
      };
    }
  );
};
