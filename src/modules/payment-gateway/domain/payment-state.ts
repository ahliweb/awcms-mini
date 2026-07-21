/**
 * Payment intent + refund state machines for `payment_gateway` (Issue #877,
 * ADR-0022 §11.5). PURE — no I/O. The whitelist here MIRRORS the DB triggers in
 * `sql/093` exactly (defence in depth: an illegal transition is refused both by
 * this domain guard AND by the trigger). Payment status is MONOTONIC or
 * explicitly compensating; an invalid regression (e.g. settled -> pending) is
 * rejected, never applied — the caller records reconciliation evidence instead.
 */

export type PaymentIntentStatus =
  | "initiated"
  | "pending"
  | "settled"
  | "failed"
  | "expired"
  | "refunded"
  | "disputed";

export const PAYMENT_INTENT_STATUSES: readonly PaymentIntentStatus[] = [
  "initiated",
  "pending",
  "settled",
  "failed",
  "expired",
  "refunded",
  "disputed"
];

const INTENT_TRANSITIONS: Readonly<
  Record<PaymentIntentStatus, readonly PaymentIntentStatus[]>
> = {
  initiated: ["pending", "failed", "expired"],
  pending: ["settled", "failed", "expired"],
  settled: ["refunded", "disputed"],
  failed: ["initiated"],
  expired: [],
  refunded: [],
  disputed: []
};

export function isLegalIntentTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus
): boolean {
  return INTENT_TRANSITIONS[from].includes(to);
}

/** A terminal intent status accepts no further forward transition except the compensating settled->refunded/disputed edges (which are themselves modeled above). */
export function isTerminalIntentStatus(status: PaymentIntentStatus): boolean {
  return status === "expired" || status === "refunded" || status === "disputed";
}

/** The provider's neutral normalized status vocabulary (from a verified webhook or a status query). */
export type NormalizedPaymentStatus =
  | "settled"
  | "failed"
  | "expired"
  | "refunded"
  | "disputed"
  | "pending"
  | "unknown";

export const NORMALIZED_PAYMENT_STATUSES: readonly NormalizedPaymentStatus[] = [
  "settled",
  "failed",
  "expired",
  "refunded",
  "disputed",
  "pending",
  "unknown"
];

export function isNormalizedPaymentStatus(
  value: unknown
): value is NormalizedPaymentStatus {
  return (
    typeof value === "string" &&
    (NORMALIZED_PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Map a NORMALIZED provider status to the intent status it would advance TO,
 * or `null` when the event carries no state change (e.g. `pending`/`unknown`).
 * The caller still checks `isLegalIntentTransition` from the CURRENT status — an
 * out-of-order `pending` after `settled` maps to null and is never applied.
 */
export function intentStatusForNormalized(
  normalized: NormalizedPaymentStatus
): PaymentIntentStatus | null {
  switch (normalized) {
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "refunded":
      return "refunded";
    case "disputed":
      return "disputed";
    case "pending":
    case "unknown":
      return null;
    default: {
      const _exhaustive: never = normalized;
      return _exhaustive;
    }
  }
}

// -------------------------------------------------------------------------
// Refund state machine
// -------------------------------------------------------------------------

// Issue #879 (ADR-0022 §5 CRITICAL-1) — maker/checker for refunds. A refund is
// REQUESTED (maker) then APPROVED (checker, a different actor, high-risk) before
// any provider dispatch; the money-out outbox is enqueued only on approval.
export type RefundStatus =
  "requested" | "approved" | "pending" | "succeeded" | "failed";

export const REFUND_STATUSES: readonly RefundStatus[] = [
  "requested",
  "approved",
  "pending",
  "succeeded",
  "failed"
];

const REFUND_TRANSITIONS: Readonly<
  Record<RefundStatus, readonly RefundStatus[]>
> = {
  requested: ["approved", "failed"],
  approved: ["pending", "failed"],
  pending: ["succeeded", "failed"],
  succeeded: [],
  failed: []
};

export function isLegalRefundTransition(
  from: RefundStatus,
  to: RefundStatus
): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

export function isTerminalRefundStatus(status: RefundStatus): boolean {
  return status === "succeeded" || status === "failed";
}
