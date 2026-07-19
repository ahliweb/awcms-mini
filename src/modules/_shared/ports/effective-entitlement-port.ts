/**
 * `effective_entitlement` capability port (Issue #871, epic #868 SaaS control
 * plane, ADR-0022 §2/§4). This is the ONE contract through which a tenant-plane
 * business module — or a downstream control-plane module (#872 provisioning,
 * #873 lifecycle, #875 usage metering, #876 subscription billing) — reads a
 * tenant's commercial entitlement to gate feature/module/quota access. It is
 * READ-ONLY and FAIL-CLOSED (ADR-0022 §4 High-2): any key that is unknown,
 * absent, indeterminate, unavailable, or resolved from a disabled/unprovisioned
 * `tenant_entitlement` returns DENY — never grant-all.
 *
 * ENTITLEMENT != PERMISSION. A positive answer here is a COMMERCIAL fact
 * ("this tenant subscribes to X"), on a DIFFERENT axis from RBAC/ABAC's
 * authorization ("this actor may do Y"). A consumer must ALSO pass its own
 * permission/module-enabled gates — this port never bypasses them, and a
 * positive entitlement can never grant an authorization the actor lacks.
 *
 * The view is TENANT-FACING ONLY: it carries the resolved decision
 * (`allowed`/`limit`) and never operator-only data (override reasons, internal
 * prices). Consumers wire the adapter
 * (`tenant-entitlement/application/effective-entitlement-port-adapter.ts`) at
 * their composition root (a route/page handler), inside their own
 * `withTenant(sql, tenantId, ...)` transaction — never a direct cross-module
 * import of `tenant_entitlement`'s application/domain code (enforced by
 * `tests/unit/module-boundary.test.ts`). There is no write side: entitlement
 * records are mutated only by `tenant_entitlement`'s own operator endpoints.
 */

/** A resolved quota allowance. `limit` is `null` iff `isUnlimited`; a denied/absent quota is `{ allowed: false, isUnlimited: false, limit: 0, unit: null }` (no allowance). */
export type QuotaAllowance = {
  allowed: boolean;
  isUnlimited: boolean;
  limit: number | null;
  unit: string | null;
};

/**
 * A bounded, tenant-facing snapshot of a tenant's effective entitlement at the
 * resolution time. `status: "disabled"` means `tenant_entitlement` is not
 * enabled for the tenant — every lookup denies. `snapshotHash` is a stable
 * fingerprint of the resolved decisions (excludes the timestamp), usable as a
 * deterministic cache-invalidation key.
 */
export type EffectiveEntitlementSnapshot = {
  tenantId: string;
  resolvedAt: string;
  status: "resolved" | "disabled";
  snapshotHash: string;
  /** feature key -> allowed (absent key = denied). */
  features: Record<string, boolean>;
  /** module key -> entitled (absent key = denied). */
  modules: Record<string, boolean>;
  /** meter key -> allowance (absent key = denied via the port's `getQuota`). */
  quotas: Record<string, QuotaAllowance>;
};

export type EffectiveEntitlementPort = {
  /** Fail-closed: `true` ONLY when the feature is strictly, positively granted for this tenant. */
  isFeatureAllowed(featureKey: string): Promise<boolean>;
  /** Fail-closed: `true` ONLY when the whole module is strictly, positively entitled for this tenant. */
  isModuleEntitled(moduleKey: string): Promise<boolean>;
  /** Fail-closed: an unknown/absent/disabled meter returns a denied allowance (no units). */
  getQuota(meterKey: string): Promise<QuotaAllowance>;
  /** The full bounded snapshot (resolved once per port instance, then cached — no per-key N+1). */
  snapshot(): Promise<EffectiveEntitlementSnapshot>;
};
