# Module Management

Implementasi Issue #513 (epic #510) — turns the static code registry
(`src/modules/index.ts`) into a database-backed, tenant-aware module
management capability. `awcms_mini_modules` (migration 001) had existed
since the very first migration but was never written to by any
application code until this issue — `src/modules/index.ts`'s
`listModules()` was the only source of truth until now.

## Descriptor sync — `application/descriptor-sync.ts`

`syncModuleDescriptors(sql, descriptors = listModules())`:

1. Reads the current `awcms_mini_modules` rows.
2. Computes a plan (`domain/descriptor-diff.ts`'s `planModuleSync` — pure,
   no I/O, unit-testable): each code descriptor is classified `create`
   (no matching DB row yet), `update` (a tracked field differs), or
   `unchanged`.
3. Upserts `awcms_mini_modules` for every `create`/`update` entry.
4. Fully replaces (`DELETE` then `INSERT`) each module's
   `awcms_mini_module_dependencies`/`_navigation`/`_jobs` rows from its
   current descriptor — cheap at this scale (a handful of rows per
   module) and guarantees the stored set can never silently drift from
   what the descriptor currently declares.
5. Any `awcms_mini_modules` row whose `module_key` is no longer in
   `listModules()` is **marked** `lifecycle_status = 'disabled'` — never
   deleted, and its dependencies/navigation/jobs rows are left untouched
   as a historical record. A module absent from code is, by `#511`'s own
   descriptor contract, globally disabled by definition.

No network calls, no user-controlled path — the only input is the
trusted, statically-imported module list already running in this
process (`src/modules/index.ts`). Safe to call repeatedly: syncing the
same descriptors twice produces `unchanged` the second time, never a
duplicate row.

These tables are global/RLS-free (migration 025's own justification —
code-derived registry metadata, not tenant data), so the sync service
runs on the plain app connection with no tenant context needed.

## `module_management`'s own descriptor

Declares `type: "system"`, `isCore: true` (module management cannot be
tenant-disabled — you cannot disable the thing that manages modules), and
its 12 seeded permissions (`migration 025`). Deliberately does **not**
declare `navigation`/`jobs`/`health`/`api` yet — those fields exist on
`ModuleDescriptor` (Issue #511) but the actual admin page (`/admin/modules`,
Issue #521), job registry (#519), health checks (#520), and API routes
(#514) don't exist yet. A descriptor should only claim a capability once
the corresponding feature is real, not in advance.

## Out of scope for this issue

Admin UI, tenant enable/disable API, and runtime plugin installation are
explicitly out of scope — see Issues #514/#515/#521 respectively.
