import type { APIRoute } from "astro";

import { fail } from "../../../../../../../modules/_shared/api-response";
import {
  listInvoices,
  type InvoiceRow
} from "../../../../../../../modules/subscription-billing/application/billing-directory";
import { toInvoiceDto } from "../../../../../../../modules/subscription-billing/application/invoice-engine";
import { isInvoiceStatus } from "../../../../../../../modules/subscription-billing/domain/invoice-state";
import {
  authorizeRead,
  isUuid,
  successBody,
  withTargetTenant
} from "../../../_support";

/** `GET /.../invoices?status=` — list a tenant's invoices (platform op or self). */
export const GET: APIRoute = async ({ request, cookies, params, url }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId))
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  const statusParam = url.searchParams.get("status");
  if (statusParam !== null && !isInvoiceStatus(statusParam)) {
    return fail(400, "VALIDATION_ERROR", "unknown status filter.");
  }
  const auth = await authorizeRead(request, cookies, tenantId, "invoices");
  if (auth instanceof Response) return auth;
  const rows: InvoiceRow[] = await withTargetTenant(tenantId, (tx) =>
    listInvoices(tx, tenantId, statusParam ? { status: statusParam } : {})
  );
  return new Response(
    JSON.stringify(successBody({ invoices: rows.map(toInvoiceDto) })),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
};
