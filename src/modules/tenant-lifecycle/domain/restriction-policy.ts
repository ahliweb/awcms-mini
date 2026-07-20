/**
 * Server-derived restriction policy (Issue #873, epic #868, ADR-0022 §6
 * High-2). Re-export of the CANONICAL policy in neutral ground
 * (`src/modules/_shared/tenant-lifecycle-policy.ts`) — see
 * `domain/lifecycle-state.ts` for why the source of truth lives outside this
 * module. Pure — no I/O.
 */
export {
  ALLOW_ALL,
  DENY_ALL,
  deriveRestrictions,
  isRestricted,
  isWriteAction,
  lifecycleAccessDecision,
  type LifecycleAccessDecision,
  type RestrictionProfile
} from "../../_shared/tenant-lifecycle-policy";
