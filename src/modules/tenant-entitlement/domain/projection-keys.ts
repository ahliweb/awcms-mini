/**
 * Stable constants for this module's own `reporting` projection (Issue #880,
 * epic #868 Wave 3 operations) — see
 * `tenant-provisioning/domain/projection-keys.ts` for the shared rationale.
 */
export const ENTITLEMENT_EVALUATIONS_PROJECTION_KEY =
  "tenant_entitlement.entitlement_evaluations";

/**
 * Metric keys — computed from
 * `awcms_mini_tenant_entitlement_evaluation_snapshots`, which is append-only
 * by construction (REVOKEd UPDATE/DELETE, migration 081) and whose `trigger`
 * is written once at insert.
 *
 * This counts how often this tenant's effective entitlement was RE-EVALUATED
 * and why — the "effective entitlement/override inventory" freshness signal
 * issue #880 asks for. The entitlement CONTENT itself is deliberately not
 * projected: the fail-closed effective snapshot is resolved live by
 * `tenant_entitlement`'s own port on every capability check, and a derived
 * read model must never become an authorization source (issue #753/#880
 * security requirement, ADR-0022 §4).
 */
export const ENTITLEMENT_EVALUATIONS_METRIC_KEYS = {
  evaluationTotal: "evaluation_total",
  assignmentChangedCount: "assignment_changed_count",
  overrideChangedCount: "override_changed_count"
} as const;
