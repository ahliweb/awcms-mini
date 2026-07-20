import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parseCreditNoteBody } from "../../../../../../../../modules/subscription-billing/application/request-parsing";
import { validateCreditNote } from "../../../../../../../../modules/subscription-billing/domain/request-validation";
import { creditInvoice } from "../../../../../../../../modules/subscription-billing/application/invoice-engine";
import { listCreditNotes } from "../../../../../../../../modules/subscription-billing/application/billing-directory";
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

const SCOPE = "subscription_billing_credit_invoice";

/** `GET` — list credit notes for an invoice (platform op or self). */
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
    listCreditNotes(tx, tenantId, invoiceId)
  );
  return new Response(JSON.stringify(successBody({ creditNotes: rows })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

/** `POST` — issue a credit note against an original issued invoice/line (operator). */
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
  const input = parseCreditNoteBody(raw);
  const errors = validateCreditNote(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "credits", "create");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    invoiceId,
    invoiceLineId: input.invoiceLineId,
    amountMinor: input.amountMinor,
    reason: input.reason
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await creditInvoice(
        tx,
        tenantId,
        invoiceId,
        {
          invoiceLineId: input.invoiceLineId,
          amountMinor: input.amountMinor,
          reason: input.reason
        },
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 201,
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
