import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parseSimpleReasonBody } from "../../../../../../../../modules/payment-gateway/application/request-parsing";
import { validateSimpleReason } from "../../../../../../../../modules/payment-gateway/domain/request-validation";
import { retryDeadOutbox } from "../../../../../../../../modules/payment-gateway/application/payment-directory";
import { auditPayment } from "../../../../../../../../modules/payment-gateway/application/payment-events";
import {
  authorizeOperator,
  errorBody,
  isUuid,
  runIdempotentPaymentMutation,
  successBody
} from "../../../../_support";

const SCOPE = "payment_gateway_retry_dlq";

/** `POST /.../outbox/{outboxId}/retry` — manually retry a dead-lettered provider dispatch (operator). */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const outboxId = params.outboxId ?? "";
  if (!isUuid(tenantId) || !isUuid(outboxId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and outboxId must be UUIDs."
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
  const input = parseSimpleReasonBody(raw);
  const errors = validateSimpleReason(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "outbox", "retry");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    outboxId,
    reason: input.reason
  });

  return runIdempotentPaymentMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const reset = await retryDeadOutbox(tx, tenantId, outboxId, new Date());
      if (!reset) {
        return {
          kind: "conflict",
          status: 409,
          body: errorBody(
            "PAYMENT_NOT_DEAD_LETTERED",
            "Outbox row is not dead-lettered (nothing to retry)."
          )
        };
      }
      await auditPayment(tx, tenantId, {
        action: "retry",
        resourceType: "payment_gateway_outbox",
        resourceId: outboxId,
        severity: "warning",
        message: `Dead-lettered provider dispatch manually re-queued: ${input.reason}`,
        attributes: { outboxId },
        ctx: { actorTenantUserId: auth.actorTenantUserId, correlationId }
      });
      return {
        kind: "success",
        status: 200,
        body: successBody({ outboxId, requeued: true })
      };
    }
  );
};
