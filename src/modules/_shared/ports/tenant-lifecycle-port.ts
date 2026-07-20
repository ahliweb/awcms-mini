/**
 * `tenant_lifecycle` capability port (Issue #873, epic #868 SaaS control plane,
 * ADR-0022 §2/§4). `tenant_lifecycle` PROVIDES two contracts here that
 * downstream modules consume at THEIR composition root WITHOUT importing
 * `tenant_lifecycle`'s application/domain code (enforced by
 * `tests/unit/module-boundary.test.ts`):
 *
 *   1. `tenant_restrictions` (read-only) — the server-derived, fail-closed
 *      restriction profile a surface (API/SSR/public/worker) enforces. This is
 *      the single source of truth for "may this tenant operate, and how much".
 *
 *   2. `lifecycle_transition` — the WRITE contract subscription billing (#876)
 *      uses to request a lifecycle transition (trial->active, active->past_due,
 *      grace->suspended, ...) instead of mutating tenant state directly
 *      (ADR-0022 §11.2 / Issue #876 dependency). Every call is validated,
 *      audited (mandatory reason), concurrency-safe, and NEVER deletes data.
 *
 * The adapters (`tenant-lifecycle/application/*-port-adapter.ts`) are bound to
 * an already tenant-scoped `tx` (the caller's `withTenant` transaction),
 * mirroring `service-catalog`/`tenant-entitlement`'s read-port adapters.
 */
import type {
  LifecycleSource,
  LifecycleState,
  RestrictionProfile
} from "../tenant-lifecycle-policy";

export type { LifecycleSource, LifecycleState, RestrictionProfile };

/**
 * The tenant-facing restriction snapshot. `governing` is false when the tenant
 * is NOT governed by lifecycle (no record) — the profile is then `ALLOW_ALL`
 * (unrestricted, baseline behavior, offline-safe). When `governing` is true the
 * profile is derived from `state` (or the fail-closed `DENY_ALL` on a read
 * error). `state` is null only when not governing.
 */
export type TenantRestrictionSnapshot = {
  tenantId: string;
  governing: boolean;
  state: LifecycleState | null;
  version: number | null;
  profile: RestrictionProfile;
  resolvedAt: string;
};

export type TenantRestrictionsPort = {
  /** Fail-closed: a governing tenant whose state cannot be read returns `DENY_ALL`, never a falsely-permissive profile. */
  resolve(): Promise<TenantRestrictionSnapshot>;
};

export type LifecycleTransitionRequest = {
  toState: LifecycleState;
  reason: string;
  source: LifecycleSource;
  /** Optimistic-concurrency guard; null = no version pin. */
  expectedVersion?: number | null;
  actorTenantUserId?: string | null;
  correlationId?: string;
};

export type LifecycleTransitionResult =
  | { ok: true; state: LifecycleState; version: number }
  | {
      ok: false;
      reason:
        "not_found" | "illegal_transition" | "version_conflict" | "validation";
      message: string;
      currentState?: LifecycleState;
      currentVersion?: number;
    };

/**
 * The write contract #876 consumes. A billing event asks lifecycle to move a
 * tenant through the state machine; lifecycle validates + audits + emits the
 * versioned event same-commit and returns a deterministic result (a
 * `version_conflict`/`illegal_transition` maps to a 409 at the caller).
 */
export type LifecycleTransitionPort = {
  requestTransition(
    request: LifecycleTransitionRequest
  ): Promise<LifecycleTransitionResult>;
};
