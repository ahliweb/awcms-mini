import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parsePaymentAllocationBody } from "../../../../../../../../modules/subscription-billing/application/request-parsing";
import { validatePaymentAllocation } from "../../../../../../../../modules/subscription-billing/domain/request-validation";
import { recordPaymentAllocation } from "../../../../../../../../modules/subscription-billing/application/invoice-engine";
import { listPaymentAllocations } from "../../../../../../../../modules/subscription-billing/application/billing-directory";
import {
  authorizeOperator,
  authorizeRead,
  billingFailureResponse,
  errorBody,
  isUuid,
  runIdempotentBillingMutation,
  successBody,
  withTargetTenant
} from "../../../../_support";

const SCOPE = "subscription_billing_record_payment";

/** `GET` — list payment allocation references (platform op or self). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  const invoiceId = params.invoiceId ?? "";
  if (!isUuid(tenantId) || !isUuid(invoiceId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and invoiceId must be UUIDs."
    );
  }
  const auth = await authorizeRead(request, cookies, tenantId, "invoices");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(tenantId, (tx) =>
    listPaymentAllocations(tx, tenantId, invoiceId)
  );
  return new Response(
    JSON.stringify(successBody({ paymentAllocations: rows })),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
};

/**
 * `POST` — record a validated manual/provider payment allocation REFERENCE
 * (operator). This is the ONLY path that updates payment state — never a
 * provider call in this transaction. Idempotent by (invoice, providerReference).
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const invoiceId = params.invoiceId ?? "";
  if (!isUuid(tenantId) || !isUuid(invoiceId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and invoiceId must be UUIDs."
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
  const input = parsePaymentAllocationBody(raw);
  const errors = validatePaymentAllocation(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "payments", "update");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    invoiceId,
    allocationSource: input.allocationSource,
    providerReference: input.providerReference,
    amountMinor: input.amountMinor,
    outcome: input.outcome,
    markPaid: input.markPaid
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await recordPaymentAllocation(
        tx,
        tenantId,
        invoiceId,
        {
          allocationSource: input.allocationSource as "manual" | "provider",
          providerKey: input.providerKey,
          providerReference: input.providerReference,
          amountMinor: input.amountMinor,
          outcome: input.outcome,
          markPaid: input.markPaid,
          reason: input.reason
        },
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
          body: successBody({
            allocationId: result.allocationId,
            invoice: result.invoice,
            replayed: result.replayed
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
