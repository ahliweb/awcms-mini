/**
 * NEUTRAL-GROUND restriction reader (Issue #873, epic #868, ADR-0022 §6
 * High-2). Reads the CURRENT lifecycle state of a tenant (a READ — never a
 * write; no-shared-table-write is unaffected) and applies the canonical pure
 * policy to produce a fail-closed `TenantRestrictionSnapshot`.
 *
 * Lives in `_shared` (not under `tenant-lifecycle/`) so BOTH the base
 * `identity_access` auth chokepoint (which ENFORCES the restriction for API +
 * SSR) AND the `tenant_lifecycle` module's own `tenant_restrictions` port
 * adapter consume the SAME reader — one enforcement decision, no drift, no
 * forbidden reverse import of the control-plane module
 * (`tests/unit/module-boundary.test.ts`, ADR-0022 §4). It reads ONLY through the
 * caller's already tenant-scoped `tx` (RLS predicate ALWAYS AND ONLY
 * `tenant_id`).
 *
 * FAIL-CLOSED / offline-safe semantics:
 *   - NO lifecycle row  -> `governing: false`, `ALLOW_ALL` (the tenant is not
 *     governed by lifecycle — the default for every LAN/offline tenant that
 *     never opted in; baseline behavior preserved, AC).
 *   - a lifecycle row   -> `governing: true`, profile derived from `state`.
 *   - an UNKNOWN state (should be impossible — CHECK-constrained) -> `DENY_ALL`.
 *   - a READ ERROR (dropped connection, missing table, RLS/permission failure)
 *     -> `governing: true`, `DENY_ALL`, NEVER throws. The port JSDoc promises
 *     "a governing tenant whose state cannot be read returns DENY_ALL, never
 *     throws", so a downstream consumer (#876) that trusts the contract cannot
 *     be tricked into a fail-OPEN `catch { unrestricted }`. Erring toward DENY
 *     is the safe default: a transient read error must not let a suspended
 *     tenant operate.
 */
import {
  ALLOW_ALL,
  DENY_ALL,
  deriveRestrictions,
  isLifecycleState,
  type LifecycleState,
  type RestrictionProfile
} from "./tenant-lifecycle-policy";

export type TenantRestrictionSnapshot = {
  tenantId: string;
  governing: boolean;
  state: LifecycleState | null;
  version: number | null;
  profile: RestrictionProfile;
  resolvedAt: string;
};

export async function readTenantRestrictionSnapshot(
  tx: Bun.SQL,
  tenantId: string,
  now: Date = new Date()
): Promise<TenantRestrictionSnapshot> {
  let rows: { state: string; version: number }[];
  try {
    rows = (await tx`
      SELECT state, version
      FROM awcms_mini_tenant_lifecycle_states
      WHERE tenant_id = ${tenantId}
    `) as { state: string; version: number }[];
  } catch {
    // Fail-CLOSED, per the port contract: a read error on a potentially
    // governing tenant denies rather than throws, so no consumer can fall
    // back to an unrestricted (fail-OPEN) profile on a transient DB fault.
    return {
      tenantId,
      governing: true,
      state: null,
      version: null,
      profile: DENY_ALL,
      resolvedAt: now.toISOString()
    };
  }

  const row = rows[0];
  if (!row) {
    return {
      tenantId,
      governing: false,
      state: null,
      version: null,
      profile: ALLOW_ALL,
      resolvedAt: now.toISOString()
    };
  }

  if (!isLifecycleState(row.state)) {
    // Fail-closed: a governing tenant whose state we cannot classify is denied.
    return {
      tenantId,
      governing: true,
      state: null,
      version: Number(row.version),
      profile: DENY_ALL,
      resolvedAt: now.toISOString()
    };
  }

  return {
    tenantId,
    governing: true,
    state: row.state,
    version: Number(row.version),
    profile: deriveRestrictions(row.state),
    resolvedAt: now.toISOString()
  };
}
