/**
 * Meter resolution against the #874 SINGLE SOURCE (Issue #875, epic #868,
 * ADR-0022). Every meter key + aggregation + bounds usage_metering acts on
 * resolves through `src/modules/_shared/saas-contract-registry.ts` (the shared
 * seam, not a private list — the same re-use `tenant_entitlement`/
 * `service_catalog` follow). An unknown meter FAILS CLOSED (`resolveMeter`
 * returns `null`). This module NEVER hardcodes a business meter set — the base
 * ships a few neutral example meters in its OWN `module.ts` to exercise the
 * mechanism; a derived app contributes its own via `application-registry.ts`.
 */
import type { ModuleDescriptor } from "../../_shared/module-contract";
import {
  isKnownMeterKey,
  resolveSaasContractRegistry,
  type SaasContractRegistry
} from "../../_shared/saas-contract-registry";
import type { ResolvedMeter } from "../domain/usage-event";

export type { SaasContractRegistry };

/** Build the merged SaaS contract registry from the composed module list (`listModules()` at the composition root). */
export function buildContractRegistry(
  descriptors: readonly ModuleDescriptor[]
): SaasContractRegistry {
  return resolveSaasContractRegistry(descriptors);
}

/** Resolve a meter's numeric-only semantics, or `null` if the key is unknown (fail-closed). */
export function resolveMeter(
  registry: SaasContractRegistry,
  meterKey: string
): ResolvedMeter | null {
  if (!isKnownMeterKey(registry, meterKey)) {
    return null;
  }
  const descriptor = registry.meters.get(meterKey);
  if (!descriptor) {
    return null;
  }
  return {
    key: descriptor.key,
    ownerModuleKey: descriptor.ownerModuleKey,
    valueType: descriptor.valueType,
    aggregation: descriptor.aggregation,
    correction: descriptor.correction,
    classification: descriptor.classification,
    privacyClassification: descriptor.privacyClassification,
    minValue: descriptor.bounds.minValue,
    maxValue: descriptor.bounds.maxValue
  };
}

/**
 * The reset period + enforcement of the FIRST quota (registry order) that limits
 * `meterKey` — a meter with no quota is `"none"`/`"advisory"` (never blocks).
 * Deterministic (registry order); if a meter has several quotas with different
 * reset periods, the first is used (documented — the base example meters each
 * have at most one quota).
 */
export function resolveQuotaPolicyForMeter(
  registry: SaasContractRegistry,
  meterKey: string
): { resetPeriod: string; enforcement: "hard" | "soft" | "advisory" } {
  for (const quota of registry.quotas.values()) {
    if (quota.meterKey === meterKey) {
      return { resetPeriod: quota.resetPeriod, enforcement: quota.enforcement };
    }
  }
  return { resetPeriod: "none", enforcement: "advisory" };
}
