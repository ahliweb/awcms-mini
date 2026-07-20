/**
 * Compensation classification (Issue #872, epic #868, ADR-0022 §9). When a run
 * fails or is canceled, each COMPLETED step is compensated according to its
 * EXPLICIT class, fixed by the plan:
 *   - `reversible` — the step's `compensate` handler runs an idempotent undo
 *     (entitlement cancel, module disable, domain deactivate, config reset) —
 *     all STATE changes, never data deletes.
 *   - `manual`     — recorded as `manual_required` for an operator; never auto-
 *     reversed (e.g. an owner identity is never silently deleted).
 *   - `forbidden`  — never reversed: either there is nothing to undo
 *     (readiness) or undoing would delete tenant data after the tenant became
 *     active (the tenant record itself). Recorded as `skipped_forbidden`.
 *
 * Pure — no I/O. The engine reads these to decide, per step, whether to call
 * the handler's `compensate`, mark `manual_required`, or `skipped_forbidden`.
 */
import type { ProvisioningCompensationClass } from "../../_shared/ports/provisioning-step-port";

export type { ProvisioningCompensationClass };

export type CompensationStatus =
  "pending" | "completed" | "manual_required" | "failed" | "skipped_forbidden";

export type CompensationAction =
  "run_compensation" | "mark_manual" | "skip_forbidden";

/** Decide what to DO with a completed step of the given class during compensation. */
export function compensationActionFor(
  compensationClass: ProvisioningCompensationClass
): CompensationAction {
  switch (compensationClass) {
    case "reversible":
      return "run_compensation";
    case "manual":
      return "mark_manual";
    case "forbidden":
      return "skip_forbidden";
  }
}

/**
 * The overall run outcome after compensation completes. A run is `failed`
 * (data-safe) once every completed step has been reversed / recorded as
 * manual / skipped-forbidden. If any step needs manual intervention OR the
 * tenant would be left active without controls, the run is `blocked` (visibly)
 * rather than silently failed — AC "no active tenant without mandatory controls
 * without a visible blocked status".
 */
export function resolveCompensationOutcome(input: {
  anyManualRequired: boolean;
  anyCompensationFailed: boolean;
}): "failed" | "blocked" {
  return input.anyManualRequired || input.anyCompensationFailed
    ? "blocked"
    : "failed";
}
