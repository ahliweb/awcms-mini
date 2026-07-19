/**
 * `service_catalog`'s view over the SINGLE SaaS contract registry (Issue #870,
 * refactored by Issue #874). Before #874 this file kept its OWN aggregation of
 * feature/meter keys from `ModuleDescriptor.serviceCatalog`; #874 moved that
 * aggregation to the one shared source of truth,
 * `src/modules/_shared/saas-contract-registry.ts` (the seam both this module
 * and `tenant_entitlement` may import without crossing a module boundary), and
 * this file now RE-EXPORTS it. There is no private key list here anymore —
 * catalog validation resolves descriptors from that one source (Issue #874 AC
 * "catalog, entitlement, and usage code can resolve descriptors from one source
 * of truth").
 *
 * A plan's feature grants reference a `featureKey` (kind `feature`) or a
 * whole-module `moduleKey` (kind `module`); its quotas reference a `meterKey`.
 * Every such key MUST resolve through the reviewed static registry — an unknown
 * key FAILS CLOSED (rejected at draft-update/validate/publish time), never
 * accepted silently (Issue #870 security requirement "unknown keys fail
 * closed").
 */
import {
  isKnownFeatureGrant,
  isKnownMeterKey,
  isValidSaasKeyFormat,
  resolveSaasContractRegistry,
  type SaasContractRegistry
} from "../../_shared/saas-contract-registry";

/** A feature grant targets a fine-grained feature or a whole module. */
export type ServiceCatalogFeatureKind = "feature" | "module";

/**
 * The allowed-key registry `service_catalog` resolves against. It IS the shared
 * `SaasContractRegistry` (superset of the historical `{ moduleKeys, featureKeys,
 * meterKeys }` shape this alias exposed before #874) — callers here only read
 * those three sets.
 */
export type ServiceCatalogKeyRegistry = SaasContractRegistry;

/** Shared syntactic key gate — re-exported from the single source. */
export function isValidServiceCatalogKeyFormat(key: string): boolean {
  return isValidSaasKeyFormat(key);
}

/** Build the allowed-key registry from a descriptor list (always `listModules()` at the application layer). Delegates to the single source of truth. */
export function resolveServiceCatalogKeyRegistry(
  descriptors: Parameters<typeof resolveSaasContractRegistry>[0]
): ServiceCatalogKeyRegistry {
  return resolveSaasContractRegistry(descriptors);
}

export { isKnownFeatureGrant, isKnownMeterKey };
