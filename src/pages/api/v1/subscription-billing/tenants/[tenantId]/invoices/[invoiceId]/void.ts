import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parseVoidInvoiceBody } from "../../../../../../../../modules/subscription-billing/application/request-parsing";
import { validateVoidInvoice } from "../../../../../../../../modules/subscription-billing/domain/request-validation";
import { voidInvoice } from "../../../../../../../../modules/subscription-billing/application/invoice-engine";
import {
  authorizeOperator,
  billingFailureResponse,
  errorBody,
  isUuid,
  runIdempotentBillingMutation,
  successBody
} from "../../../../_support";

const SCOPE = "subscription_billing_void_invoice";

/** `POST /.../invoices/{invoiceId}/void` — void an invoice (correction, never edit/delete). */
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
  const input = parseVoidInvoiceBody(raw);
  const errors = validateVoidInvoice(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "invoices", "void");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    invoiceId,
    reason: input.reason,
    expectedVersion: input.expectedVersion
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await voidInvoice(
        tx,
        tenantId,
        invoiceId,
        { reason: input.reason, expectedVersion: input.expectedVersion },
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
          body: successBody({ invoice: result.invoice })
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
