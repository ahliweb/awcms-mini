---
"awcms-mini": minor
---

Add deterministic build-time module composition (Issue #740, epic #738
`platform-evolution`, Wave 1, ADR-0014) — a derived/downstream repository
can now contribute its own application modules to the final, effective
module registry without ever editing `src/modules/index.ts` or any base
`module.ts`.

`src/modules/application-registry.ts` is the single, designated build-time
extension point: this base repository ships `undefined` there; a derived
repository replaces that export with its own `ApplicationModuleRegistry`
(`{ id, modules, migrationNamespace? }`, a new type in
`src/modules/_shared/module-contract.ts`). Still 100% compile-time
TypeScript, resolved by `bun run build`/`bun run typecheck` like any other
import — no runtime discovery, file upload, package scanning, `eval`, or
untrusted code loading (doc 21 §7 unchanged, not relaxed).

`src/modules/module-management/domain/module-composition.ts` provides the
composition API: `mergeModuleRegistries()` (pure concatenation, always
succeeds — the only thing `src/modules/index.ts` itself calls, so a
default base build produces the exact same effective registry as before
this change), and `composeModuleRegistry()`/`validateComposedModuleRegistry()`
(the rule engine, called explicitly by the new `bun run
modules:compose:check`, never embedded in module load). It composes and
validates module keys/descriptors, the lifecycle dependency DAG (reusing
the existing whole-registry validator, Issue #680), capability
provides/consumes bindings, permission/navigation/job/health inventories,
a declared migration namespace/range per application registry (base
reserves `1-899`), and deployment-profile compatibility metadata (a new
`ModuleCompatibilityContract.deploymentProfiles` field) — failing fast
with actionable diagnostics on duplicate module keys, missing/cyclic
dependencies, missing or conflicting capability providers, an invalid
application module category, an overlapping migration namespace, an
incompatible deployment-profile claim, a navigation path conflict, or an
application registry attempting to shadow/replace any base module.

New CI gates wired into `bun run check`: `bun run modules:compose:check`
and `bun run modules:composition:inventory:generate`/`:check` (a
deterministic, machine-readable composed-registry snapshot,
`docs/awcms-mini/module-composition-inventory.json`, for CI/release
evidence). `scripts/repo-inventory-generate.ts` now accepts an optional
module list, proving repository inventory generation works in both
base-only and composed-fixture modes without touching its default CLI
behavior.

A minimal in-repo fixture derived application
(`tests/fixtures/derived-application-example/`, two modules) proves the
whole mechanism end to end (`tests/unit/module-composition-fixture.test.ts`)
without ever being wired into this repository's real
`application-registry.ts`. `tests/unit/module-composition.test.ts` covers
composition and every rejection class with synthetic descriptors.

See `docs/adr/0014-deterministic-build-time-module-composition.md` for the
full design decision, and `docs/awcms-mini/derived-application-guide.md`
for the updated derived-application contributor flow.
