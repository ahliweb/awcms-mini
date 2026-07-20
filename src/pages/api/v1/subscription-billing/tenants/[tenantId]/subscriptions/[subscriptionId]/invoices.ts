import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parseGenerateInvoiceBody } from "../../../../../../../../modules/subscription-billing/application/request-parsing";
import { validateGenerateInvoice } from "../../../../../../../../modules/subscription-billing/domain/request-validation";
import { generateInvoiceDraft } from "../../../../../../../../modules/subscription-billing/application/invoice-engine";
import { listInvoices } from "../../../../../../../../modules/subscription-billing/application/billing-directory";
import { toInvoiceDto } from "../../../../../../../../modules/subscription-billing/application/invoice-engine";
import {
  authorizeOperator,
  authorizeRead,
  billingFailureResponse,
  errorBody,
  invoiceDeps,
  isUuid,
  runIdempotentBillingMutation,
  successBody,
  withTargetTenant
} from "../../../../_support";

const SCOPE = "subscription_billing_generate_invoice";

/** `GET` — list invoices for a subscription (platform op or self). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  const subscriptionId = params.subscriptionId ?? "";
  if (!isUuid(tenantId) || !isUuid(subscriptionId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and subscriptionId must be UUIDs."
    );
  }
  const auth = await authorizeRead(request, cookies, tenantId, "invoices");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(tenantId, (tx) =>
    listInvoices(tx, tenantId, { subscriptionId })
  );
  return new Response(
    JSON.stringify(successBody({ invoices: rows.map(toInvoiceDto) })),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
};

/** `POST` — generate an idempotent invoice draft for the subscription's current period (operator). */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const subscriptionId = params.subscriptionId ?? "";
  if (!isUuid(tenantId) || !isUuid(subscriptionId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and subscriptionId must be UUIDs."
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
  const input = parseGenerateInvoiceBody(raw);
  const errors = validateGenerateInvoice(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "invoices", "create");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    subscriptionId,
    includeUsage: input.includeUsage,
    dueInDays: input.dueInDays
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await generateInvoiceDraft(
        tx,
        tenantId,
        subscriptionId,
        {
          includeUsage: input.includeUsage,
          dueInDays: input.dueInDays,
          reason: input.reason
        },
        invoiceDeps(tx, tenantId),
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: result.created ? 201 : 200,
          body: successBody({
            invoice: result.invoice,
            created: result.created
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
