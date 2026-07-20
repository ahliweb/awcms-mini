/**
 * `subscription_billing` invoice status machine (Issue #876, epic #868,
 * ADR-0022 §11). Mirrors the DB trigger whitelist in `sql/091` EXACTLY.
 *
 *   draft  -> issued | void
 *   issued -> paid | void
 *   paid   -> (terminal; a refund is a credit note, never a status change)
 *   void   -> (terminal)
 *
 * The moment an invoice leaves `draft` it is IMMUTABLE (amounts/currency/period
 * frozen); the ONLY further change is a legal status advance. Correction is a
 * credit note or a void — never an edit or delete.
 */
export type InvoiceStatus = "draft" | "issued" | "paid" | "void";

export type InvoiceStatusSource =
  "operator" | "system" | "scheduler" | "payment" | "reconciliation";

export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  "draft",
  "issued",
  "paid",
  "void"
];

const LEGAL: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ["issued", "void"],
  issued: ["paid", "void"],
  paid: [],
  void: []
};

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return (
    typeof value === "string" &&
    (INVOICE_STATUSES as readonly string[]).includes(value)
  );
}

export function isLegalInvoiceTransition(
  from: InvoiceStatus,
  to: InvoiceStatus
): boolean {
  return LEGAL[from].includes(to);
}

/** An issued invoice's financial substance is frozen — only a status advance is legal. */
export function isInvoiceImmutable(status: InvoiceStatus): boolean {
  return status !== "draft";
}
