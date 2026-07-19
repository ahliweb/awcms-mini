/**
 * Static allowed-key registry for `tenant_entitlement` (Issue #871, epic #868,
 * ADR-0022). An override targets a `feature`/`module`/`quota` (meter) key;
 * every such key MUST resolve through THIS reviewed, static registry — an
 * unknown key FAILS CLOSED (rejected at override-create time; and any resolved
 * key not present in a tenant's grants is denied at read time), never accepted
 * silently (AC "unknown keys fail closed").
 *
 * The registry is the compile-time union of what modules declare in their own
 * `ModuleDescriptor.serviceCatalog` (feature/meter keys) plus the live module
 * registry's own keys (module-entitlement keys ARE `listModules()`'s keys —
 * derived from the registry, never a hand-kept list, memory
 * `derive-publish-roots-from-registry`). A derived application contributes its
 * own keys the same way through `application-registry.ts` (Issue #740).
 *
 * WHY DUPLICATE service_catalog's aggregation instead of importing it. The
 * module boundary (ADR-0022 §4, `tests/unit/module-boundary.test.ts`) forbids a
 * tenant-plane / downstream control-plane module from importing another
 * module's `application`/`domain` code — so `tenant_entitlement` reads the
 * SHARED, plain-data descriptors (`ModuleDescriptor`, `listModules()`) directly
 * rather than importing `service-catalog/domain/key-registry.ts`. This ~20-line
 * aggregation is the same shape service_catalog uses; #874 formalizes a single
 * conformance gate over both.
 */
import type { ModuleDescriptor } from "../../_shared/module-contract";
import type { OverrideTargetKind } from "./entitlement";

export type EntitlementKeyRegistry = {
  /** Valid whole-module entitlement keys — the live module registry's own keys. */
  moduleKeys: ReadonlySet<string>;
  /** Valid fine-grained feature keys, unioned from every module's `serviceCatalog.contributesFeatureKeys`. */
  featureKeys: ReadonlySet<string>;
  /** Valid usage-meter keys, unioned from every module's `serviceCatalog.contributesMeterKeys`. */
  meterKeys: ReadonlySet<string>;
};

const KEY_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export function isValidEntitlementKeyFormat(key: string): boolean {
  return typeof key === "string" && key.length <= 120 && KEY_FORMAT.test(key);
}

/** Build the allowed-key registry from a descriptor list (always `listModules()` at the application layer — passed in so this stays pure and unit-testable with synthetic descriptors). */
export function resolveEntitlementKeyRegistry(
  descriptors: readonly ModuleDescriptor[]
): EntitlementKeyRegistry {
  const moduleKeys = new Set<string>();
  const featureKeys = new Set<string>();
  const meterKeys = new Set<string>();

  for (const descriptor of descriptors) {
    moduleKeys.add(descriptor.key);
    for (const key of descriptor.serviceCatalog?.contributesFeatureKeys ?? []) {
      featureKeys.add(key);
    }
    for (const key of descriptor.serviceCatalog?.contributesMeterKeys ?? []) {
      meterKeys.add(key);
    }
  }

  return { moduleKeys, featureKeys, meterKeys };
}

/** Whether an override's `(kind, key)` is a known, reviewed target. Fail-closed: anything not present returns `false`. */
export function isKnownEntitlementTarget(
  registry: EntitlementKeyRegistry,
  kind: OverrideTargetKind,
  key: string
): boolean {
  if (!isValidEntitlementKeyFormat(key)) {
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
