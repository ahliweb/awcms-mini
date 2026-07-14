# Derived Application Example (fixture)

Minimal, in-repo fixture derived application (Issue #740, epic #738
`platform-evolution`, Wave 1) — **not a separate real repository, and not
part of the base registry**. It exists solely to exercise and prove the
build-time module composition API
(`src/modules/module-management/domain/module-composition.ts`) end to end,
consumed only by
[`tests/unit/module-composition-fixture.test.ts`](../../unit/module-composition-fixture.test.ts).

## What this illustrates

A real derived repository (see
`docs/awcms-mini/derived-application-guide.md`) forks/vendors this base
repository, then replaces `src/modules/application-registry.ts`'s
`undefined` export with its own `ApplicationModuleRegistry` — the ONLY
file it needs to edit; `src/modules/index.ts` and every base `module.ts`
stay untouched. This directory is a working, compilable illustration of
that shape:

- [`modules/example-crm/module.ts`](modules/example-crm/module.ts) —
  depends on base Core modules (`tenant_admin`, `identity_access`),
  provides the `example_crm_directory` capability, declares one
  permission/navigation/job entry, and a `compatibility.deploymentProfiles`
  hint.
- [`modules/example-loyalty/module.ts`](modules/example-loyalty/module.ts) —
  depends on `example_crm` (an application-to-application lifecycle edge,
  not just base-to-application), and consumes its
  `example_crm_directory` capability as a REQUIRED binding.
- [`modules/example-erp-extension/module.ts`](modules/example-erp-extension/module.ts)
  (Issue #755, epic #738 `platform-evolution` Wave 4, ADR-0019 — ERP
  extension readiness contracts) — a sample ERP extension consuming
  `profile_identity`'s `party_directory` and `organization_structure`'s
  `organization_hierarchy_resolution` capabilities (both `optional: true`,
  never a hard lifecycle dependency), and contributing a `reporting`
  projection (Issue #753) driven entirely by its own posting-result domain
  event. Its sibling
  [`posting-engine.ts`](modules/example-erp-extension/posting-engine.ts)
  and
  [`period-lock-adapter.ts`](modules/example-erp-extension/period-lock-adapter.ts)
  are a pure, in-memory reference implementation of `_shared/business-
transaction-contract.ts`'s posting request/result invariants and
  `_shared/ports/period-lock-port.ts`'s fail-closed contract — idempotent
  posting, fail-closed period lock, cross-tenant/legal-entity mismatch
  rejection, and reversal-as-a-new-transaction — exercised by
  [`tests/unit/erp-extension-contracts.test.ts`](../../unit/erp-extension-contracts.test.ts).
  Owns its own illustration-only table
  ([`sql/901_example_erp_extension_schema.sql`](sql/901_example_erp_extension_schema.sql))
  entirely inside the fixture's reserved migration range — the base
  repository contains no chart-of-accounts/journal/inventory-valuation/
  sales/procurement/AR-AP/payroll/tax/asset/manufacturing table, per
  ADR-0019's explicit exclusions.
- [`application-registry.ts`](application-registry.ts) — the
  `ApplicationModuleRegistry` combining all three modules plus a declared
  `migrationNamespace` (`900-999`, non-overlapping with the base's own
  reserved `1-899`).
- [`extension.manifest.json`](extension.manifest.json) +
  [`sql/900_example_crm_schema.sql`](sql/900_example_crm_schema.sql)
  (Issue #741, epic #738 `platform-evolution`, Wave 1, ADR-0015) — the
  COMPATIBLE derived-application compatibility manifest a real derived
  repository would publish at its own repository root, checked by
  `bun run extension:check`
  (`scripts/extension-check.ts` →
  `src/modules/module-management/domain/extension-compatibility.ts`).
  The `.sql` file is illustration-only (never applied to a real
  database) — it exists so the manifest's `migrations.historicalChecksums`
  entry has a real file to declare an immutable checksum against. See
  [`../extension-contract-incompatible/README.md`](../extension-contract-incompatible/README.md)
  for eight sibling fixtures, each this same manifest with exactly one
  deliberate incompatibility.

## What it proves (see the consuming test)

- Composing `listBaseModules()` with this fixture succeeds
  (`valid: true`), includes both fixture modules, and the resulting
  registry independently passes `validateModuleDependencyGraph` — the
  same whole-registry DAG check `bun run modules:dag:check` runs.
- The base repository's own `listModules()`/`src/modules/index.ts` are
  completely unaffected — this fixture is never wired into either.
- `extension.manifest.json` passes `bun run extension:check` end to end
  (real spawned CLI, not just a direct function call) — see
  [`tests/unit/extension-check-fixtures.test.ts`](../../unit/extension-check-fixtures.test.ts).

## What this is not

Not a template for a real domain module's full structure (`domain/`,
`application/`, `infrastructure/`, `api/`, a real `README.md` — see skill
`awcms-mini-new-module` for that). No real endpoints, no migrations, no
database access — purely `ModuleDescriptor`/`ApplicationModuleRegistry`
shapes for composition testing.
