/**
 * `billing_document_state` capability adapter (Issue #876, epic #868, ADR-0022
 * §2/§4). `subscription_billing` PROVIDES this READ-ONLY port; the future
 * `payment_gateway` (#877) wires it at ITS composition root to learn which
 * invoices are payable — without importing this module's application/domain
 * code (module-boundary). Bound to the caller's already tenant-scoped `tx`.
 * Amounts are EXACT minor units; no operator reason / billing contact / secret
 * crosses this boundary.
 */
import type {
  BillingDocumentSnapshot,
  BillingDocumentStatePort
} from "../../_shared/ports/billing-document-port";
import { getInvoice, listInvoices } from "./billing-directory";
import { toInvoiceDto } from "./invoice-engine";

function toSnapshot(dto: {
  id: string;
  subscriptionId: string;
  status: BillingDocumentSnapshot["status"];
  currency: string;
  totalMinor: number;
  creditedMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  dueAt: string | null;
  issuedAt: string | null;
}): BillingDocumentSnapshot {
  return {
    invoiceId: dto.id,
    subscriptionId: dto.subscriptionId,
    status: dto.status,
    currency: dto.currency,
    totalMinor: dto.totalMinor,
    creditedMinor: dto.creditedMinor,
    allocatedMinor: dto.allocatedMinor,
    outstandingMinor: dto.outstandingMinor,
    dueAt: dto.dueAt,
    issuedAt: dto.issuedAt
  };
}

export function createBillingDocumentStatePort(
  tx: Bun.SQL,
  tenantId: string
): BillingDocumentStatePort {
  return {
    async getInvoice(
      invoiceId: string
    ): Promise<BillingDocumentSnapshot | null> {
      const row = await getInvoice(tx, tenantId, invoiceId);
      return row ? toSnapshot(toInvoiceDto(row)) : null;
    },
    async listPayable(limit = 100): Promise<BillingDocumentSnapshot[]> {
      const rows = await listInvoices(tx, tenantId, {
        status: "issued",
        limit
      });
      return rows
        .map((row) => toSnapshot(toInvoiceDto(row)))
        .filter((snap) => snap.outstandingMinor > 0);
    }
  };
}
