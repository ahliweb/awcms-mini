/**
 * Stable constants for this module's own `reporting` projection (Issue #880,
 * epic #868 Wave 3 operations) — see
 * `tenant-provisioning/domain/projection-keys.ts` for the shared rationale.
 */
export const INVOICE_LIFECYCLE_PROJECTION_KEY =
  "subscription_billing.invoice_lifecycle";

/**
 * Metric keys — computed from
 * `awcms_mini_subscription_billing_invoice_status_history`, append-only under
 * both a `BEFORE UPDATE OR DELETE` trigger and `REVOKE UPDATE, DELETE`
 * (migration 091), whose `to_status` is written once at insert.
 *
 * These are TRANSITION counts, not an invoice-state gauge or an aged
 * receivable balance. Two deliberate non-goals, both from ADR-0013 §3 /
 * ADR-0022 §11: this is not a general ledger or AR-AP, and no MONEY amount is
 * projected here at all — a counter is a count of state changes, and totalling
 * exact minor-unit amounts through an increment-only float-free counter that
 * cannot be corrected downward is exactly the shape a billing figure must
 * never have. Amounts stay in the authoritative invoice rows, read live via
 * this projection's `drillDownPath`.
 */
export const INVOICE_LIFECYCLE_METRIC_KEYS = {
  transitionTotal: "transition_total",
  toDraftCount: "to_draft_count",
  toIssuedCount: "to_issued_count",
  toPaidCount: "to_paid_count",
  toVoidCount: "to_void_count"
} as const;
