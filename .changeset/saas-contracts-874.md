---
"awcms-mini": minor
---

feat(saas-contracts): add static feature, quota, meter, and commercial-event registries with conformance gates (#874)

Adds the build-time **SaaS contract registry** (epic #868, ADR-0022) — the single
source of truth for the commercial identifiers the SaaS control plane uses:
features, usage meters, quota limit dimensions, and lifecycle/commercial domain
events. `service_catalog` (#870) and `tenant_entitlement` (#871) now **re-export**
this one aggregator (`src/modules/_shared/saas-contract-registry.ts`) instead of
each keeping a private key-list, retiring the drift the #871 drift-guard test
previously defended.

- **Rich versioned descriptors** on `ModuleDescriptor.serviceCatalog`
  (`features`/`meters`/`quotas`/`commercialEvents`), plus the `SAAS_CONTRACT_VERSION`
  constant. Meters carry event version, quantity/value type, aggregation rule,
  correction semantics, an **explicit privacy classification**, billable-versus-
  informational classification, and numeric bounds; quotas carry unit, reset
  period, and enforcement mode. Meter descriptors are numeric-only (no raw-payload
  field), so they cannot request raw sensitive-payload storage by default.
- **Fail-closed validation** (`bun run saas-contracts:registry:check`, wired into
  `bun run check` + `ci.yml`): duplicate keys, feature/meter collisions, unknown
  owner, unsafe unit, NaN/overflow/negative bounds (negative only with explicit
  `signed_delta` correction), aggregation incompatible with value type, missing
  privacy classification, dangling quota→meter references, `hard` enforcement on
  an informational meter, event/AsyncAPI parity gaps, and the deprecated pre-#874
  thin key fields all fail the build and fail runtime validation closed.
- **Generated inventory** (owner module, version, unit, aggregation, privacy
  class, billable) as machine-readable JSON + human-readable Markdown, with a
  freshness gate.
- **Compatibility-manifest integration**: derived repositories declare a
  `saasContractVersion` in `extension.manifest.json`, checked by
  `bun run extension:check` (MAJOR-match, MINOR-ceiling). A ninth incompatible
  fixture proves the gate.

MINOR/additive module-contract change (`MODULE_CONTRACT_VERSION` 1.3.0 -> 1.4.0,
`EXTENSION_MANIFEST_SCHEMA_VERSION` 1.0.0 -> 1.1.0): the pre-#874
`contributesFeatureKeys`/`contributesMeterKeys` fields are kept (now `@deprecated`,
rejected by the gate with a migration message) so an old derived `module.ts` still
type-checks. No runtime table/migration is added — the registry is build-time and
static.
