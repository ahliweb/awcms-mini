/**
 * `payment_outcome` capability port (Issue #877, epic #868 SaaS control plane,
 * ADR-0022 §2/§4). `payment_gateway` PRODUCES validated payment outcomes; a
 * downstream commercial module (`subscription_billing` #876) CONSUMES them to
 * transition an invoice — WITHOUT `payment_gateway` importing
 * `subscription_billing`'s application/domain code (enforced by
 * `tests/unit/module-boundary.test.ts`). The adapter that forwards a settled/
 * refunded outcome to `subscription_billing.recordPaymentAllocation` is wired at
 * `payment_gateway`'s COMPOSITION ROOT (route/job `_support`), never inside its
 * engines — the engines take this port as an OPTIONAL dependency.
 *
 * A payment outcome is ONLY ever derived from a VERIFIED signed webhook or a
 * reconciliation outcome — NEVER a browser redirect (ADR-0022 §9). This port has
 * no read side and carries no provider secret / raw PII: amounts are EXACT minor
 * units, references are opaque provider ids.
 *
 * `optional: true` per ADR-0022 — a LAN/offline/standalone `payment_gateway`
 * with no billing module wired still records payment state fully; only the
 * back-propagation of a settlement to a subscription invoice degrades to a no-op.
 */

export type PaymentSettlementNotice = {
  /** The billing invoice this payment settles (a REFERENCE, resolved via billing_document_state). */
  invoiceId: string;
  providerKey: string;
  /** Opaque provider reference (charge/session id) — never a secret. */
  providerReference: string;
  /** EXACT minor units. */
  amountMinor: number;
  currency: string;
};

export type PaymentRefundNotice = {
  invoiceId: string;
  providerKey: string;
  providerReference: string;
  /** EXACT minor units (the refunded magnitude, positive). */
  amountMinor: number;
  currency: string;
};

export type PaymentOutcomePort = {
  /** Notify a consumer that a payment settled a payable invoice (records a validated allocation reference). */
  notifySettled(notice: PaymentSettlementNotice): Promise<void>;
  /** Notify a consumer that a settled payment was refunded (records a reversing/credit reference). */
  notifyRefunded(notice: PaymentRefundNotice): Promise<void>;
};
