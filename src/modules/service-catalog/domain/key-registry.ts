/**
 * Static allowed-key registry for `service_catalog` (Issue #870, epic #868
 * SaaS control plane, ADR-0022). A plan's feature grants reference a
 * `featureKey` (kind `feature`) or a whole-module `moduleKey` (kind
 * `module`); its quotas reference a `meterKey`. Every such key MUST resolve
 * through THIS reviewed, static registry — an unknown key FAILS CLOSED
 * (rejected at draft-update/validate/publish time), never accepted silently
 * (Issue #870 security requirement "unknown keys fail closed").
 *
 * There is no runtime discovery, upload, or `eval` (doc 21 §7 / ADR-0012 §7):
 * the registry is the compile-time union of what modules declare in their own
 * `ModuleDescriptor.serviceCatalog` (feature/meter keys) plus the live module
 * registry itself (module-entitlement keys are simply `listModules()`'s keys —
 * derived from the registry, never a hand-kept list, memory
 * `derive-publish-roots-from-registry`). A derived application contributes its
 * own keys the same way, through `application-registry.ts` (Issue #740) — no
 * base-registry edit. #874 formalizes conformance gates on top of this seam.
 */
import type { ModuleDescriptor } from "../../_shared/module-contract";

export type ServiceCatalogFeatureKind = "feature" | "module";

export type ServiceCatalogKeyRegistry = {
  /** Valid whole-module entitlement keys — the live module registry's own keys. */
  moduleKeys: ReadonlySet<string>;
  /** Valid fine-grained feature keys, unioned from every module's `serviceCatalog.contributesFeatureKeys`. */
  featureKeys: ReadonlySet<string>;
  /** Valid usage-meter keys, unioned from every module's `serviceCatalog.contributesMeterKeys`. */
  meterKeys: ReadonlySet<string>;
};

const KEY_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** Shared syntactic gate — a key must match this before any registry membership check (mirrors the DB CHECK constraints in sql/079). */
export function isValidServiceCatalogKeyFormat(key: string): boolean {
  return typeof key === "string" && key.length <= 120 && KEY_FORMAT.test(key);
}

/**
 * Build the allowed-key registry from a descriptor list (always
 * `listModules()` at the application layer — passed in so this stays pure and
 * unit-testable with synthetic descriptors).
 */
export function resolveServiceCatalogKeyRegistry(
  descriptors: readonly ModuleDescriptor[]
): ServiceCatalogKeyRegistry {
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

/**
 * Whether a feature grant's `(kind, key)` pair is known. `module` kind checks
 * the module registry; `feature` kind checks the contributed feature keys.
 * Fail-closed: anything not present returns `false`.
 */
export function isKnownFeatureGrant(
  registry: ServiceCatalogKeyRegistry,
  kind: ServiceCatalogFeatureKind,
  key: string
): boolean {
  if (!isValidServiceCatalogKeyFormat(key)) {
    return false;
  }
  return kind === "module"
    ? registry.moduleKeys.has(key)
    : registry.featureKeys.has(key);
}

/** Whether a quota's meter key is a known, reviewed meter (fail-closed). */
export function isKnownMeterKey(
  registry: ServiceCatalogKeyRegistry,
  key: string
): boolean {
  return isValidServiceCatalogKeyFormat(key) && registry.meterKeys.has(key);
}
