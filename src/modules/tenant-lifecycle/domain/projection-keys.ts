/**
 * Stable constants for this module's own `reporting` projection (Issue #880,
 * epic #868 Wave 3 operations) — see
 * `tenant-provisioning/domain/projection-keys.ts` for the shared rationale
 * (declared by the owning module, aggregated by `reporting`, never a
 * cross-module write).
 */
export const LIFECYCLE_TRANSITIONS_PROJECTION_KEY =
  "tenant_lifecycle.lifecycle_transitions";

/**
 * Metric keys — computed from `awcms_mini_tenant_lifecycle_history`, an
 * append-only timeline whose `event_kind`/`to_state` are written once at
 * insert and never updated.
 *
 * `entered*` counts are TRANSITION counts (how many times this tenant entered
 * that state), deliberately not a "current state" gauge: a monotonic
 * increment-only cursor counter cannot express a value that moves in both
 * directions, and the authoritative current state already lives in
 * `awcms_mini_tenant_lifecycle_states` (read live via
 * `GET /api/v1/tenant-lifecycle/tenants/{tenantId}`, this projection's
 * `drillDownPath`). Counting entries into `suspended`/`grace`/`past_due` is
 * the operational signal issue #880 asks for — repeated churn through a
 * degraded state is invisible in a current-state gauge.
 */
export const LIFECYCLE_TRANSITIONS_METRIC_KEYS = {
  historyTotal: "history_total",
  transitionCount: "transition_count",
  downgradeCount: "downgrade_count",
  scheduleSetCount: "schedule_set_count",
  scheduleCanceledCount: "schedule_canceled_count",
  restoreCount: "restore_count",
  reconciledCount: "reconciled_count",
  enteredActive: "entered_active",
  enteredTrial: "entered_trial",
  enteredRenewalDue: "entered_renewal_due",
  enteredPastDue: "entered_past_due",
  enteredGrace: "entered_grace",
  enteredSuspended: "entered_suspended",
  enteredCanceled: "entered_canceled",
  enteredBlocked: "entered_blocked"
} as const;
