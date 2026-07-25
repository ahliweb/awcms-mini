/**
 * Stable constants for this module's own `reporting` projection (Issue #880,
 * epic #868 Wave 3 operations) — see
 * `tenant-provisioning/domain/projection-keys.ts` for the shared rationale.
 */
export const USAGE_RECONCILIATION_PROJECTION_KEY =
  "usage_metering.usage_reconciliation_outcomes";

/**
 * Metric keys — computed from `awcms_mini_usage_reconciliation_runs`, which a
 * BEFORE UPDATE OR DELETE trigger (migration 087) keeps strictly append-only
 * and whose `status` is written once, at completion, in the same INSERT.
 *
 * `awcms_mini_usage_events`/`awcms_mini_usage_corrections` are deliberately
 * NOT projected even though they are this module's highest-volume tables:
 * both are age-purged by `purgeExpiredUsageEvents`
 * (`usage_metering.events` data-lifecycle descriptor), and an all-time
 * increment-only counter over a table rows are deleted from would permanently
 * disagree with `reporting`'s own reconciliation control total — reporting a
 * drift that is really just retention doing its job. Reconciliation runs are
 * low-volume, never purged, and are the signal an operator actually needs
 * ("usage freshness ... and reconciliation", issue #880).
 */
export const USAGE_RECONCILIATION_METRIC_KEYS = {
  runTotal: "run_total",
  consistentCount: "consistent_count",
  driftDetectedCount: "drift_detected_count",
  failedCount: "failed_count"
} as const;
