/**
 * `billing_document_state` capability port (Issue #876, epic #868 SaaS control
 * plane, ADR-0022 §2/§4). `subscription_billing` PROVIDES this READ-ONLY
 * contract; the future `payment_gateway` module (#877) consumes it at ITS
 * composition root to learn which invoices are payable and what an outcome
 * should settle — WITHOUT importing `subscription_billing`'s application/domain
 * code (enforced by `tests/unit/module-boundary.test.ts`).
 *
 * There is NO write side to payment here. `subscription_billing` updates an
 * invoice's paid/void state ONLY from a validated adapter/reconciliation
 * OUTCOME (#877), recorded via the module's own audited, idempotent mutation —
 * never a provider call inside a billing transaction (ADR-0006 / ADR-0022 §9).
 * This port is the read seam a payment module reads to decide what to charge;
 * the settlement result flows back through the module's own
 * `recordPaymentAllocation` write path.
 *
 * TENANT-FACING SHAPE ONLY: amounts are EXACT minor units (integer), currency
 * is a single ISO code per document. No operator reason, no billing contact, no
 * provider secret ever crosses this boundary. The adapter
 * (`subscription-billing/application/billing-document-port-adapter.ts`) is bound
 * to the caller's already tenant-scoped `tx`.
 */

export type BillingInvoiceStatus = "draft" | "issued" | "paid" | "void";

/** A payable/settled invoice document snapshot — the commercial STATE only (never an accounting entry). */
export type BillingDocumentSnapshot = {
  invoiceId: string;
  subscriptionId: string;
  status: BillingInvoiceStatus;
  currency: string;
  /** EXACT minor units. */
  totalMinor: number;
  creditedMinor: number;
  allocatedMinor: number;
  /** total - credited - allocated, clamped at 0 (what remains payable). */
  outstandingMinor: number;
  dueAt: string | null;
  issuedAt: string | null;
};

export type BillingDocumentStatePort = {
  /** The document snapshot for one invoice, or `null` if not found in the tenant scope. */
  getInvoice(invoiceId: string): Promise<BillingDocumentSnapshot | null>;
  /** Bounded list of currently payable (issued, outstanding > 0) invoices, newest first. */
  listPayable(limit?: number): Promise<BillingDocumentSnapshot[]>;
};
