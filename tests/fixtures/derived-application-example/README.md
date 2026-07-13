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
- [`application-registry.ts`](application-registry.ts) — the
  `ApplicationModuleRegistry` combining both modules plus a declared
  `migrationNamespace` (`900-999`, non-overlapping with the base's own
  reserved `1-899`).

## What it proves (see the consuming test)

- Composing `listBaseModules()` with this fixture succeeds
  (`valid: true`), includes both fixture modules, and the resulting
  registry independently passes `validateModuleDependencyGraph` — the
  same whole-registry DAG check `bun run modules:dag:check` runs.
- The base repository's own `listModules()`/`src/modules/index.ts` are
  completely unaffected — this fixture is never wired into either.

## What this is not

Not a template for a real domain module's full structure (`domain/`,
`application/`, `infrastructure/`, `api/`, a real `README.md` — see skill
`awcms-mini-new-module` for that). No real endpoints, no migrations, no
database access — purely `ModuleDescriptor`/`ApplicationModuleRegistry`
shapes for composition testing.
