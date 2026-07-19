/**
 * `tenant_entitlement`'s view over the SINGLE SaaS contract registry (Issue
 * #871, refactored by Issue #874). An override targets a `feature`/`module`/
 * `quota` (meter) key; every such key MUST resolve through the reviewed static
 * registry — an unknown key FAILS CLOSED (rejected at override-create time; and
 * any resolved key not present in a tenant's grants is denied at read time),
 * never accepted silently (AC "unknown keys fail closed").
 *
 * BEFORE #874 this file DUPLICATED `service_catalog`'s key aggregation (to
 * avoid importing `service-catalog/domain/*` across the module boundary), and a
 * drift-guard unit test asserted the two aggregations stayed identical. #874
 * removes the duplication: the ONE aggregator now lives in
 * `src/modules/_shared/saas-contract-registry.ts` — the shared seam both
 * modules may import without crossing a module boundary — and BOTH this file
 * and `service-catalog/domain/key-registry.ts` re-export it. The drift is gone
 * because there is nothing left to drift: a single source, resolved by both
 * (Issue #874 AC). The entitlement-specific helpers (`isEntitlementGatedModule`,
 * `resolveGatedModuleKeys`, `overrideResolutionCap`, and the override
 * `kind`→namespace mapping in `isKnownEntitlementTarget`) stay here — they are
 * about tenant entitlement, not about which keys exist.
 */
import type { ModuleDescriptor } from "../../_shared/module-contract";
import {
  isValidSaasKeyFormat,
  resolveSaasContractRegistry,
  type SaasContractRegistry
} from "../../_shared/saas-contract-registry";
import type { OverrideTargetKind } from "./entitlement";

/** The allowed-key registry `tenant_entitlement` resolves against — the shared `SaasContractRegistry` (callers here read `moduleKeys`/`featureKeys`/`meterKeys`). */
export type EntitlementKeyRegistry = SaasContractRegistry;

export function isValidEntitlementKeyFormat(key: string): boolean {
  return isValidSaasKeyFormat(key);
}

/** Build the allowed-key registry from a descriptor list (always `listModules()` at the application layer). Delegates to the single source of truth. */
export function resolveEntitlementKeyRegistry(
  descriptors: readonly ModuleDescriptor[]
): EntitlementKeyRegistry {
  return resolveSaasContractRegistry(descriptors);
}

/**
 * Whether a module is COMMERCIALLY GATED — i.e. a tenant must be ENTITLED to
 * use it, as opposed to a base/foundational module the platform always provides
 * (tenant_admin, identity_access, logging, module_management, ...). A module is
 * gated iff it is an opt-in business/integration module (`type` is `domain`/
 * `integration`/`derived`) OR it is a default-disabled control-plane module.
 * Base/system foundation (`type` `base`/`system`/undefined, not default-
 * disabled) is always-available. Used by safe-downgrade so an ABSENT gated
 * dependency fails closed (DENY) while an absent base dependency stays satisfied
 * (Issue #871 review Fix 2, ADR-0022 §4).
 */
export function isEntitlementGatedModule(
  descriptor: ModuleDescriptor
): boolean {
  if (descriptor.defaultTenantState === "disabled") {
    return true;
  }
  return (
    descriptor.type === "domain" ||
    descriptor.type === "integration" ||
    descriptor.type === "derived"
  );
}

/** The set of commercially-gated module keys, from the live descriptor list (`listModules()`). */
export function resolveGatedModuleKeys(
  descriptors: readonly ModuleDescriptor[]
): Set<string> {
  const keys = new Set<string>();
  for (const descriptor of descriptors) {
    if (isEntitlementGatedModule(descriptor)) {
      keys.add(descriptor.key);
    }
  }
  return keys;
}

/**
 * The maximum number of ACTIVE overrides a single tenant can hold — one per
 * distinct `(target_kind, target_key)` (the partial unique index in sql/081
 * `WHERE revoked_at IS NULL`), so it is exactly the registry cardinality:
 * |moduleKeys| + |featureKeys| + |meterKeys|. Used to size the resolution query
 * so a legitimate override set NEVER truncates (Issue #871 review Fix 5) — a
 * silently-truncated override set could drop a DENY and fail OPEN.
 */
export function overrideResolutionCap(
  descriptors: readonly ModuleDescriptor[]
): number {
  const registry = resolveSaasContractRegistry(descriptors);
  return (
    registry.moduleKeys.size +
    registry.featureKeys.size +
    registry.meterKeys.size
  );
}

/** Whether an override's `(kind, key)` is a known, reviewed target. Fail-closed: anything not present returns `false`. An override `quota` targets a meter key. */
export function isKnownEntitlementTarget(
  registry: EntitlementKeyRegistry,
  kind: OverrideTargetKind,
  key: string
): boolean {
  if (!isValidSaasKeyFormat(key)) {
    return false;
  }
  switch (kind) {
    case "feature":
      return registry.featureKeys.has(key);
    case "module":
      return registry.moduleKeys.has(key);
    case "quota":
      return registry.meterKeys.has(key);
    default:
      return false;
  }
}
