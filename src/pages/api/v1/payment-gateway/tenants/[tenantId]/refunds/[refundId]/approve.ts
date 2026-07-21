import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { approveRefund } from "../../../../../../../../modules/payment-gateway/application/refund-engine";
import {
  authorizeOperator,
  errorBody,
  isUuid,
  paymentFailureResponse,
  runIdempotentPaymentMutation,
  successBody
} from "../../../../_support";

const SCOPE = "payment_gateway_approve_refund";

/**
 * `POST /.../refunds/{refundId}/approve` — Issue #879 (ADR-0022 §5 CRITICAL-1)
 * CHECKER step. High-risk `approve` action: the SoD chokepoint blocks any actor
 * who also holds `payment_gateway.refunds.create` (rule
 * `payment_gateway.refund_create_vs_approve`), so the money-out is only ever
 * dispatched after a SECOND, distinct actor approves. Idempotency + step-up
 * required (control-plane step-up registry).
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const refundId = params.refundId ?? "";
  if (!isUuid(tenantId) || !isUuid(refundId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and refundId must be UUIDs."
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
  const auth = await authorizeOperator(request, cookies, "refunds", "approve");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({ tenantId, refundId });

  return runIdempotentPaymentMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await approveRefund(tx, tenantId, refundId, {
        actorTenantUserId: auth.actorTenantUserId,
        correlationId
      });
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
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
