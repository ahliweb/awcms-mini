---
"awcms-mini": minor
---

Eliminate the live `tenant_admin`/`profile_identity`/`identity_access`
module dependency cycle and add a registry-wide DAG validator (Issue
#680, epic #679).

`tenant_admin`'s `dependencies` array previously listed
`profile_identity`/`identity_access`, which — combined with those two
modules' own (already-correct) dependency arrays — formed a live 3-node
cycle that `domain/tenant-module-lifecycle.ts`'s existing
`hasDependencyCycle` would reject if anyone ever tried to enable one of
these three foundational modules through the normal lifecycle path.
`tenant_admin.dependencies` is now `[]`: its one-time setup wizard's
cross-module writes (into `profile_identity`/`identity_access` tables,
in the same bootstrap transaction) moved from an implicit module
dependency into `application/platform-bootstrap.ts`'s
`bootstrapPlatformTenant`, an explicit composition-root function the
route handler calls directly — behavior-identical, including the
setup-once idempotency lock.

A new registry-wide validator,
`domain/module-dependency-graph.ts`'s `validateModuleDependencyGraph`,
closes the gap that let this cycle go undetected: it checks the ENTIRE
registry (not just one module being enabled) for self-dependencies,
duplicate dependencies, missing dependency keys, and cycles
(direct/indirect), reporting every distinct issue in one run. Wired
into a new `bun run modules:dag:check` script (spliced into `bun run
check` right after `api:spec:check`) and into `bun run modules:sync`
(refuses to sync a broken graph to the database mirror table).
