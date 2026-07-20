import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import {
  getInvoice,
  listCreditNotes,
  listInvoiceLines,
  listInvoiceStatusHistory,
  listPaymentAllocations
} from "../../../../../../../../modules/subscription-billing/application/billing-directory";
import { toInvoiceDto } from "../../../../../../../../modules/subscription-billing/application/invoice-engine";
import {
  authorizeRead,
  isUuid,
  successBody,
  withTargetTenant
} from "../../../../_support";

/**
 * `GET /.../invoices/{invoiceId}` — the tenant-facing invoice read (lines,
 * status history, credit notes, payment allocation references + a download
 * metadata block). Platform operator OR the target tenant's own user; a tenant
 * user sees only its own record (RLS), and can never mutate an issued invoice.
 */
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
  const data = await withTargetTenant(tenantId, async (tx) => {
    const invoice = await getInvoice(tx, tenantId, invoiceId);
    if (!invoice) return null;
    const [lines, history, credits, payments] = [
      await listInvoiceLines(tx, tenantId, invoiceId),
      await listInvoiceStatusHistory(tx, tenantId, invoiceId),
      await listCreditNotes(tx, tenantId, invoiceId),
      await listPaymentAllocations(tx, tenantId, invoiceId)
    ];
    const dto = toInvoiceDto(invoice);
    return {
      invoice: dto,
      lines,
      statusHistory: history,
      creditNotes: credits,
      paymentAllocations: payments,
      download: {
        // Metadata for a downstream document renderer; no PII in this block.
        available: dto.status !== "draft",
        invoiceNumber: dto.invoiceNumber,
        currency: dto.currency,
        totalMinor: dto.totalMinor,
        outstandingMinor: dto.outstandingMinor
      }
    };
  });
  if (!data) return fail(404, "RESOURCE_NOT_FOUND", "Invoice not found.");
  return new Response(JSON.stringify(successBody(data)), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
