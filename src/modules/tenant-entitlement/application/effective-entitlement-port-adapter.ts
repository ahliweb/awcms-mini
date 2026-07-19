/**
 * `effective_entitlement` capability adapter (Issue #871, epic #868, ADR-0022
 * §2/§4). `tenant_entitlement` PROVIDES this port; tenant-plane business
 * modules and downstream control-plane modules (#872/#873/#875/#876) wire it at
 * THEIR composition root (a route/page handler) instead of importing
 * `tenant_entitlement`'s application/domain directly (enforced by
 * `tests/unit/module-boundary.test.ts`).
 *
 * This adapter is the ONE place the fail-closed gating decision lives for
 * downstream consumers (ADR-0022 §4 High-2, a helper — never per-route, memory
 * `ssr-admin-pages-skip-module-enabled`):
 *   - `tenant_entitlement` DISABLED for the tenant -> a `disabled` snapshot,
 *     every lookup denies (a control-plane module silently active on a LAN box
 *     must never grant access, ADR-0022 §7).
 *   - resolution ERROR -> DENY (never grant-all), logged (sanitized).
 *   - one resolution per port instance, cached -> no per-key N+1.
 * The adapter is bound to an already tenant-scoped `tx` (the caller's
 * `withTenant` transaction), mirroring `service-catalog`'s read-port adapter.
 */
import { log } from "../../../lib/logging/logger";
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import type {
  EffectiveEntitlementPort,
  EffectiveEntitlementSnapshot,
  QuotaAllowance
} from "../../_shared/ports/effective-entitlement-port";
import {
  disabledEntitlement,
  getQuota,
  isFeatureAllowed,
  isModuleEntitled,
  type EffectiveEntitlement
} from "../domain/resolution";
import {
  resolveTenantEntitlement,
  TENANT_ENTITLEMENT_MODULE_KEY,
  type EntitlementResolutionDeps
} from "./entitlement-resolution";

/** Map the rich internal resolution to the tenant-facing snapshot (decisions only, no operator reasons/sources). */
function toSnapshot(
  entitlement: EffectiveEntitlement
): EffectiveEntitlementSnapshot {
  const features: Record<string, boolean> = {};
  for (const [key, decision] of Object.entries(entitlement.features)) {
    features[key] = decision.allowed;
  }
  const modules: Record<string, boolean> = {};
  for (const [key, decision] of Object.entries(entitlement.modules)) {
    modules[key] = decision.allowed;
  }
  const quotas: Record<string, QuotaAllowance> = {};
  for (const [key, decision] of Object.entries(entitlement.quotas)) {
    quotas[key] = {
      allowed: decision.allowed,
      isUnlimited: decision.isUnlimited,
      limit: decision.limit,
      unit: decision.unit
    };
  }
  return {
    tenantId: entitlement.tenantId,
    resolvedAt: entitlement.resolvedAt,
    status: entitlement.status,
    snapshotHash: entitlement.snapshotHash,
    features,
    modules,
    quotas
  };
}

const DENIED_ALLOWANCE: QuotaAllowance = {
  allowed: false,
  isUnlimited: false,
  limit: 0,
  unit: null
};

/**
 * @param nowProvider defaults to `() => new Date()`; injectable for as-of/test.
 */
export function createEffectiveEntitlementPort(
  tx: Bun.SQL,
  tenantId: string,
  deps: EntitlementResolutionDeps,
  nowProvider: () => Date = () => new Date()
): EffectiveEntitlementPort {
  let cached: Promise<EffectiveEntitlement> | null = null;

  function resolveOnce(): Promise<EffectiveEntitlement> {
    if (!cached) {
      cached = resolveFailClosed();
    }
    return cached;
  }

  async function resolveFailClosed(): Promise<EffectiveEntitlement> {
    const now = nowProvider();
    try {
      const enabled = await resolveModuleEnabled(
        tx,
        tenantId,
        TENANT_ENTITLEMENT_MODULE_KEY
      );
      if (!enabled) {
        // Fail-closed: a disabled/unprovisioned control plane grants nothing.
        return disabledEntitlement(tenantId, now);
      }
      return await resolveTenantEntitlement(tx, tenantId, deps, now);
    } catch (error) {
      // Fail-closed: any resolution error DENIES (never grant-all, ADR-0022 §4).
      log("error", "tenant_entitlement.resolution_failed", {
        moduleKey: TENANT_ENTITLEMENT_MODULE_KEY,
        tenantId,
        errorName: error instanceof Error ? error.name : "unknown"
      });
      return disabledEntitlement(tenantId, now);
    }
  }

  return {
    async isFeatureAllowed(featureKey: string): Promise<boolean> {
      return isFeatureAllowed(await resolveOnce(), featureKey);
    },
    async isModuleEntitled(moduleKey: string): Promise<boolean> {
      return isModuleEntitled(await resolveOnce(), moduleKey);
    },
    async getQuota(meterKey: string): Promise<QuotaAllowance> {
      const decision = getQuota(await resolveOnce(), meterKey);
      return {
        allowed: decision.allowed,
        isUnlimited: decision.isUnlimited,
        limit: decision.limit,
        unit: decision.unit
      };
    },
    async snapshot(): Promise<EffectiveEntitlementSnapshot> {
      return toSnapshot(await resolveOnce());
    }
  };
}

export { DENIED_ALLOWANCE };
