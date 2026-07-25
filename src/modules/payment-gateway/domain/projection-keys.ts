/**
 * Stable constants for this module's own `reporting` projection (Issue #880,
 * epic #868 Wave 3 operations) — see
 * `tenant-provisioning/domain/projection-keys.ts` for the shared rationale.
 */
export const PAYMENT_PROCESSING_PROJECTION_KEY =
  "payment_gateway.payment_processing_outcomes";

/**
 * Metric keys — computed from
 * `awcms_mini_payment_gateway_processing_attempts`, append-only under both a
 * `BEFORE UPDATE OR DELETE` trigger and `REVOKE UPDATE, DELETE` (migration
 * 093), whose `outcome` is written once at insert.
 *
 * One row is appended for every attempt to apply a NORMALIZED (already
 * signature-verified, anti-replayed, account-bound) provider event to a
 * payment intent, so the `ignored_*` counters are the webhook-pipeline
 * backlog/health signal issue #880 asks for: a rising
 * `ignored_out_of_order`/`ignored_unknown_intent` means provider events are
 * arriving that this tenant's intents cannot absorb, which is invisible in
 * intent state alone.
 *
 * `awcms_mini_payment_gateway_webhook_inbox` is deliberately NOT the source:
 * its rows carry the stored provider envelope, and it keeps a guarded
 * `received -> normalized` UPDATE path (so a status discriminator CAN change
 * after a cursor has already passed that row — the one thing an
 * increment-only counter cannot represent).
 * Counting the append-only attempt log instead is both correct under an
 * increment-only counter and free of any envelope/PII exposure — a metric key
 * and an integer are all this projection ever stores (ADR-0022 Medium-2: no
 * raw provider payload in a projection, log, or export).
 */
export const PAYMENT_PROCESSING_METRIC_KEYS = {
  attemptTotal: "attempt_total",
  appliedCount: "applied_count",
  ignoredOutOfOrderCount: "ignored_out_of_order_count",
  ignoredDuplicateCount: "ignored_duplicate_count",
  ignoredTerminalCount: "ignored_terminal_count",
  ignoredUnknownIntentCount: "ignored_unknown_intent_count"
} as const;
