/**
 * Pure tenant-lifecycle state machine (Issue #873, epic #868, ADR-0022 §11.2).
 *
 * The CANONICAL definition lives in neutral ground
 * (`src/modules/_shared/tenant-lifecycle-policy.ts`) so the base
 * `identity_access` auth chokepoint can ENFORCE lifecycle restrictions without
 * importing this control-plane module (a forbidden reverse dependency —
 * `tests/unit/module-boundary.test.ts`). This module re-exports it so the rest
 * of the module (and its tests) import the state machine from their own
 * `domain/`, while there is exactly ONE source of truth. Pure — no I/O.
 */
export {
  isCanceledTerminal,
  isLegalTransition,
  isLifecycleSource,
  isLifecycleState,
  isRestorableState,
  isSchedulableFrom,
  legalTargetsFrom,
  LIFECYCLE_SOURCES,
  LIFECYCLE_STATES,
  type LifecycleSource,
  type LifecycleState
} from "../../_shared/tenant-lifecycle-policy";
