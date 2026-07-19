# SaaS Contract Registry (Issue #874)

The **SaaS contract registry** is the single, build-time source of truth for the
commercial identifiers the SaaS control plane uses: **features**, **usage
meters**, **quota** limit dimensions, and **lifecycle/commercial domain events**.
It exists so plan definitions (`service_catalog`, #870), entitlement enforcement
(`tenant_entitlement`, #871), and usage metering (#875) resolve the same reviewed
descriptors instead of each keeping a private key list that can silently drift.

- **Descriptor types + `SAAS_CONTRACT_VERSION`**:
  [`src/modules/_shared/module-contract.ts`](../../src/modules/_shared/module-contract.ts)
  (the `Saas*Descriptor` families under `ServiceCatalogModuleContract`).
- **The one aggregator + validator + membership helpers**:
  [`src/modules/_shared/saas-contract-registry.ts`](../../src/modules/_shared/saas-contract-registry.ts).
- **Generated inventory** (do not hand-edit):
  [`saas-contract-registry.generated.md`](saas-contract-registry.generated.md) +
  `saas-contract-registry.generated.json`.
- **Gate**: `bun run saas-contracts:registry:check` (part of `bun run check`).
- **Placement / boundary**: [ADR-0022](../adr/0022-saas-control-plane-admission-boundary-and-lifecycle-contracts.md).

## Why one shared registry

`service_catalog` and `tenant_entitlement` both need the same feature/meter/quota
key sets. The module boundary forbids one module importing another module's
`domain`/`application` code, so before #874 each module kept its own copy of the
key aggregation (defended by a drift-guard test). #874 removes the duplication:
the one aggregator lives in `_shared/` — the shared seam every module may import —
and both modules' registry files (`service-catalog/domain/key-registry.ts`,
`tenant-entitlement/domain/entitlement-key-registry.ts`) **re-export** it. There
is nothing left to drift.

## Contract schema

Every module declares its contributions in its own `module.ts`
(`ModuleDescriptor.serviceCatalog`) as trusted, reviewed, code-only data. There is
no runtime discovery, upload, or `eval`; the registry is the compile-time union of
these arrays across the deterministic `listModules()` composition seam.

### Feature descriptor

| Field            | Notes                                                      |
| ---------------- | ---------------------------------------------------------- |
| `key`            | Globally unique. `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, ≤120. |
| `ownerModuleKey` | Must equal the declaring module's own `key`.               |
| `description`    | Required.                                                  |

### Meter descriptor

| Field                   | Notes                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `key`                   | Globally unique; disjoint from feature keys.                                                      |
| `ownerModuleKey`        | Must equal the declaring module's own `key`.                                                      |
| `description`           | Required.                                                                                         |
| `eventVersion`          | `"X.Y"`.                                                                                          |
| `valueType`             | `count` \| `gauge` \| `amount_minor` \| `duration_seconds` \| `bytes`.                            |
| `aggregation`           | `sum` \| `max` \| `last` \| `unique_count`. Must be compatible with `valueType`.                  |
| `correction`            | `none` \| `signed_delta` (the only case a negative lower bound is allowed).                       |
| `classification`        | `billable` \| `informational` (billable-versus-informational).                                    |
| `privacyClassification` | `non_personal` \| `pseudonymous` \| `personal`. **Required, explicit.**                           |
| `bounds`                | `{ minValue, maxValue }` — finite integers, `maxValue ≤ 9007199254740991`, `minValue ≤ maxValue`. |

A meter descriptor carries only an aggregatable numeric quantity — there is no
raw-payload field, so a descriptor cannot request raw sensitive payload storage by
default.

### Quota descriptor

| Field            | Notes                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `key`            | Globally unique.                                                                          |
| `ownerModuleKey` | Must equal the declaring module's own `key`.                                              |
| `description`    | Required.                                                                                 |
| `meterKey`       | Must resolve to a known meter in the merged registry.                                     |
| `unit`           | `^[a-z][a-z0-9_]*$`, ≤40.                                                                 |
| `resetPeriod`    | `none` \| `daily` \| `weekly` \| `monthly` \| `quarterly` \| `yearly` \| `billing_cycle`. |
| `enforcement`    | `hard` \| `soft` \| `advisory`. `hard` is rejected on an `informational` meter.           |

### Commercial-event descriptor

| Field            | Notes                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| `eventType`      | Dotted address; must also be in the module's `events.publishes` (AsyncAPI parity). |
| `eventVersion`   | `"X.Y"`.                                                                           |
| `ownerModuleKey` | Must equal the declaring module's own `key`.                                       |
| `kind`           | `lifecycle` \| `commercial`.                                                       |
| `description`    | Required.                                                                          |

## Contribution guide

1. Declare descriptors in your module's own `module.ts` under `serviceCatalog`
   (see [`src/modules/service-catalog/module.ts`](../../src/modules/service-catalog/module.ts)
   for neutral base examples, and
   [`tests/fixtures/derived-application-example/modules/example-loyalty/module.ts`](../../tests/fixtures/derived-application-example/modules/example-loyalty/module.ts)
   for a dummy derived-module contribution).
2. A derived application contributes through its own modules via
   `src/modules/application-registry.ts` (Issue #740) — never by editing a base
   registry file.
3. Regenerate the inventory: `bun run saas-contracts:inventory:generate`, and
   commit both generated files.
4. `bun run saas-contracts:registry:check` (in `bun run check`) validates the
   registry, event/AsyncAPI parity, and inventory freshness.

## Fail-closed rules

Unknown or conflicting descriptors **fail the build** and **fail runtime
validation closed** (`isKnown*` returns `false` for anything not in the reviewed
registry). The validator rejects: duplicate keys, feature/meter key collisions,
`ownerModuleKey` mismatch, unsafe units, NaN/overflow/negative bounds (negative
only allowed with explicit `signed_delta`), aggregation incompatible with
`valueType`, missing/invalid privacy classification, dangling quota→meter
references, `hard` enforcement on an `informational` meter, commercial events
absent from `events.publishes`, and the deprecated pre-#874 thin fields
(`contributesFeatureKeys`/`contributesMeterKeys`).

## Versioning

`SAAS_CONTRACT_VERSION` versions the descriptor shape (scheme #7 in
[`extension-compatibility-policy.md`](extension-compatibility-policy.md)): MAJOR
when a field/enum is removed/retyped or a rule tightens; MINOR for a new optional
field/enum member; PATCH for documentation. A derived repository declares the
version it was authored against in its `extension.manifest.json`
`saasContractVersion` field, checked (MAJOR-match, MINOR-ceiling) by
`bun run extension:check`. Descriptor-shape changes also bump
`MODULE_CONTRACT_VERSION` (the `serviceCatalog` field is part of it) and require a
changeset.
