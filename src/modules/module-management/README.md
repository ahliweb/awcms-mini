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
its 12 seeded permissions (`migration 025`). Also declares one `navigation`
entry (Issue #518 — `/admin/modules`, gated by `module_management.modules.read`)
now that a real, if minimal, page exists there, and three `jobs` entries
(Issue #519 — `security:readiness`/`config:validate`/`production:preflight`,
platform-wide checks not owned by any single domain module). Deliberately
still does **not** declare `health` — that field exists on
`ModuleDescriptor` (Issue #511) but health checks (#520) don't exist yet.
A descriptor should only claim a capability once the corresponding
feature is real, not in advance.

## Tenant module lifecycle — `application/tenant-module-lifecycle.ts` (Issue #515)

`GET/POST /api/v1/tenant/modules(/{moduleKey}/enable|disable)`. Pure
dependency-graph validation lives in
`domain/tenant-module-lifecycle.ts` (missing/disabled dependency, active
reverse dependency, cycle detection, `minAppVersion` incompatibility,
core-module protection) — see that file and
`src/modules/identity-access/README.md`'s "Enforcement modul disabled"
section for how a disabled module is actually blocked everywhere, not just
in this module's own state row.

## Tenant module settings — `application/module-settings.ts` (Issue #516)

`GET/PATCH /api/v1/tenant/modules/{moduleKey}/settings`. Non-secret,
tenant-scoped operational preferences only (`awcms_mini_module_settings`,
migration 025) — never provider secrets/tokens, which stay in environment
variables or a secret manager.

- **Effective settings** = the module descriptor's own `settings.defaults`
  (trusted code metadata) with the tenant's stored override applied on top
  (`domain/module-settings.ts`'s `mergeEffectiveSettings`, pure). No module
  currently declares `settings.defaults` — the merge still works correctly
  against an empty object, and a future module can add defaults without any
  change here.
- **`PATCH` is a shallow, top-level merge** into the existing override
  (`{ ...before, ...patch }`) — omitted keys are left untouched. This is
  true partial-update semantics, deliberately different from
  `PATCH /api/v1/settings`'s `featureFlags` (which replaces that field
  wholesale) — `featureFlags` is one named field on a different resource,
  while here the entire request body _is_ the settings resource, so a
  caller updating one key must not be forced to resend every other key it
  never meant to touch.
- **Secret-shaped keys are rejected, not redacted**, at `PATCH` time
  (`validateModuleSettingsPatch`, checked recursively via
  `_shared/redaction.ts`'s `findSensitiveKeys` — the same
  `REDACTION_KEYS` list the logger and audit trail already use, now also
  extended with `credential`). A value the app never persisted can't leak
  later; redaction-on-read stays as a defense-in-depth complement for
  anything already at rest (e.g. via a future descriptor's own
  `settings.defaults`, though the descriptor contract's own doc comment
  already says never to declare a secret-shaped default there).
- **Audit carries safe diff metadata only** — `diffModuleSettings` reports
  which top-level keys were added/changed/removed, never the values, so
  the audit trail is useful without needing its own redaction pass to stay
  safe (`recordAuditEvent` redacts defensively anyway, belt and suspenders).
- **`schemaVersion`** is tracked (stored on write, read back from the row,
  defaulting to the descriptor's own declared version or `1`) but no
  migration-between-versions logic exists yet — out of scope until a real
  module actually bumps its settings shape.

## Module permission sync/status — `application/permission-sync.ts` (Issue #517)

`GET /api/v1/modules/{moduleKey}/permissions`. Read-only comparison
between a module's descriptor-declared `permissions` (trusted code
metadata, `ModuleDescriptor.permissions`) and the actual
`awcms_mini_permissions` catalog rows for that module —
`domain/permission-sync.ts`'s `comparePermissions`, pure, no I/O.

- **`synced`** — declared and present, same description.
- **`missing`** — declared in the descriptor, no catalog row (a migration
  seeding it hasn't run yet, or was simply never added).
- **`orphaned`** — a catalog row exists, no descriptor declares it anymore.
  **Never auto-deleted or auto-corrected** — this is a report an operator
  reads and acts on manually (issue's own security note), not a mutation.
- **`mismatched_description`** — present in both, but the description text
  differs.
- **The "optional safe sync action" the issue mentions is deliberately not
  implemented.** `descriptor-sync.ts` (Issue #513) already upserts
  `awcms_mini_modules`/`_dependencies`/`_navigation`/`_jobs` from
  `listModules()`, but never touches `awcms_mini_permissions` — extending
  it to write permissions too is a real, separate capability the
  acceptance criteria for this issue doesn't actually require (only the
  read-side report does), so it's left out rather than half-built.
- **Only `module_management`'s own descriptor currently declares
  `permissions`** (the other 9 registered modules' permissions were seeded
  directly by their own migrations, e.g. migration 005/010/014, without
  ever being added to their `module.ts`). This means every one of those
  modules' catalog permissions legitimately shows as `orphaned` today —
  an honest reflection of incomplete descriptor metadata, not a real
  drift/incident. Backfilling every other module's `permissions` array is
  out of scope here (the issue itself says this metadata is "optional...
  if not completed in Issue 1" — #511 didn't do it for the pre-existing
  modules, and this issue's job is the comparison service, not that
  backfill).
- A `moduleKey` that is neither a registered descriptor nor present in the
  permission catalog at all is `404` — distinct from a registered module
  with zero declared permissions (still `200`, an empty or
  all-`orphaned` report).

## Module navigation registry — `application/navigation-registry.ts` (Issue #518)

`AdminLayout.astro`'s sidebar. Reads navigation candidates directly from
`listModules()` (never `awcms_mini_module_navigation` — same reasoning as
`tenant-module-lifecycle.ts`: that table only reflects whatever
`bun run modules:sync` last wrote, and a sidebar rendered on every single
`/admin/*` request must never depend on someone having remembered to run a
sync first). `domain/navigation-registry.ts`'s `filterVisibleNavigationEntries`
(pure) decides visibility:

- Hidden if the module is globally `disabled` (code/deployment-level) —
  `experimental`/`deprecated`/`maintenance` still show.
- Hidden if the tenant has disabled that module
  (`awcms_mini_tenant_modules.enabled = false`).
- Hidden if the entry declares a `requiredPermission` the caller doesn't
  hold. No `requiredPermission` declared at all means always visible (to
  anyone who can already reach `/admin/*`).
- Survivors sort by `order` ascending.

**The 4 pre-existing hardcoded sidebar items (Dashboard/Access &
Users/Sync/Settings) are deliberately left exactly as they were** —
still hardcoded in `AdminLayout.astro`, still using their own
prefix-based permission checks (`hasAccessMenu`/`hasSyncMenu`). Converting
them to descriptor-declared entries with a single `requiredPermission`
each would risk _changing_ who sees them (their current checks are
"holds any `identity_access.*`/`sync_storage.*` permission", not one
specific permission key) — out of scope for this issue, which only needs
to add the registry _alongside_ the existing items, not migrate them onto
it. The registry-driven list is appended after those 4, currently
surfacing exactly one entry: `module_management`'s own `/admin/modules`.
A failure loading the registry (e.g. a transient DB hiccup) falls back to
an empty list — same defensive pattern as `tenantName`/`syncActive` above
it — so it never hides the 4 hardcoded items or otherwise locks an admin
out.

`src/pages/admin/modules.astro` is deliberately minimal — a read-only
module catalog table (reusing `fetchModuleCatalog`, Issue #514), no
mutation affordance at all. It exists only so this issue's new nav entry
doesn't point at a 404; the real experience (filters, module detail,
dependency/settings/permission-sync/navigation/jobs/health panels, tenant
enable/disable actions) is Issue #521's job.

## Module job registry — `application/job-registry.ts` (Issue #519)

`GET /api/v1/modules/{moduleKey}/jobs`. Documentation only — never
executes anything, and there is deliberately no corresponding "run this
job" endpoint (issue's own security note: running arbitrary commands from
a web UI is out of scope; if job execution is ever added, it must be a
separate, heavily-restricted feature). Reads directly from `listModules()`
— same reasoning as the navigation registry (#518): `awcms_mini_module_jobs`
only reflects whatever `bun run modules:sync` last wrote, and this is
operator-facing documentation that shouldn't silently go stale.

Job ownership (`ModuleDescriptor.jobs`) by module:

- `sync_storage` — `sync:objects:dispatch`.
- `logging` — `logs:audit:purge`.
- `form_drafts` — `form-drafts:purge`.
- `email` — `email:dispatch`, `email:provider:health`,
  `email:templates:seed-defaults`.
- `module_management` — `security:readiness`, `config:validate`,
  `production:preflight` (platform-wide/deployment-level checks that
  aren't owned by any single domain module — `module_management` is
  already the "generic infrastructure for managing every other registered
  module", the natural home for these).

Scheduling guidance (LAN/systemd/container/Coolify) lives in
`docs/awcms-mini/deployment-profiles.md` §Job registry lainnya and
`docs/awcms-mini/deploy-coolify.md` §Dispatcher terjadwal (email) — not
duplicated here.

`domain/job-registry.ts`'s `validateJobDescriptor` checks structural shape
only (`command` must look like `bun run <script>`, `purpose` non-empty).
"No secrets in job metadata" (acceptance criteria) is enforced the same
way as every other `ModuleDescriptor` field — review discipline on
trusted, checked-in code, per the contract's own doc comment — not an
automated content scanner: a free-text `environmentNotes`/`purpose`
string has no reliable secret-shaped _key_ the way a JSON-object settings
value does (`findSensitiveKeys`, Issue #516).

## Out of scope for this issue

Admin UI, and runtime plugin installation are explicitly out of scope —
see Issue #521.
