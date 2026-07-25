/**
 * Stable constants for this module's own `reporting` projection (Issue #880,
 * epic #868 Wave 3 operations) — single source of truth reused by `module.ts`
 * (the actual `ProjectionDescriptor`) and by every test, never re-typed as a
 * string literal at more than one call site (the discipline
 * `reporting/domain/projection-keys.ts` established for the base module's own
 * three projections).
 *
 * The projection is owned and declared HERE, by the module that owns the
 * source table — `reporting` only aggregates
 * (`collectProjectionDescriptors(listModules())`) and runs its generic
 * engine over what each module declared. No cross-module shared-table write
 * exists in either direction.
 */
export const PROVISIONING_OUTCOMES_PROJECTION_KEY =
  "tenant_provisioning.provisioning_outcomes";

/**
 * Metric keys — computed from `awcms_mini_tenant_provisioning_step_attempts`,
 * whose `outcome` column is written once at insert and never updated: the
 * table is append-only under BOTH a `BEFORE UPDATE OR DELETE` trigger and
 * `REVOKE UPDATE, DELETE` on the runtime role (migration 085). That is what
 * makes an increment-only cursor counter a faithful summary of it, rather
 * than a value that silently drifts when a row's discriminator changes after
 * the cursor has already passed it — the append-only-source rule every
 * descriptor in this repo follows (`reporting/README.md` §Projections).
 */
export const PROVISIONING_OUTCOMES_METRIC_KEYS = {
  attemptTotal: "attempt_total",
  attemptSucceeded: "attempt_succeeded",
  attemptFailed: "attempt_failed",
  attemptWaiting: "attempt_waiting",
  attemptSkipped: "attempt_skipped"
} as const;
