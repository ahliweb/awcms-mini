import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { approveCredit } from "../../../../../../../../modules/subscription-billing/application/invoice-engine";
import {
  authorizeOperator,
  billingFailureResponse,
  errorBody,
  isUuid,
  runIdempotentBillingMutation,
  successBody
} from "../../../../_support";

const SCOPE = "subscription_billing_approve_credit";

/**
 * `POST /.../credits/{creditNoteId}/approve` — Issue #879 (ADR-0022 §5
 * CRITICAL-1) CHECKER step. High-risk `approve` action: the SoD chokepoint blocks
 * any actor who also holds `subscription_billing.credits.create` (rule
 * `subscription_billing.credit_create_vs_approve`), so a credit is only ever
 * applied to a tenant's invoice balance after a SECOND, distinct actor approves.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const creditNoteId = params.creditNoteId ?? "";
  if (!isUuid(tenantId) || !isUuid(creditNoteId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and creditNoteId must be UUIDs."
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
  const auth = await authorizeOperator(request, cookies, "credits", "approve");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({ tenantId, creditNoteId });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await approveCredit(tx, tenantId, creditNoteId, {
        actorTenantUserId: auth.actorTenantUserId,
        correlationId
      });
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
          body: successBody({
            creditNoteId: result.creditNoteId,
            invoice: result.invoice
          })
        };
      }
      const mapped = billingFailureResponse(result.reason);
      return {
        kind: "conflict",
        status: mapped.status,
        body: errorBody(mapped.code, result.message)
      };
    }
  );
};
