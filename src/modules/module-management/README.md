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
- **Only `module_management` and `blog_content`'s descriptors currently
  declare `permissions`** (`blog_content` added its full 36-entry array in
  Issue #543, closing epic #536 — grep `permissions:` across
  `src/modules/*/module.ts` to confirm which modules declare it as code
  evolves). The other 9 registered modules' permissions (email,
  form-drafts, identity-access, logging, profile-identity, reporting,
  sync-storage, tenant-admin, workflow-approval) were seeded directly by
  their own migrations, e.g. migration 005/010/014, without ever being
  added to their `module.ts`. This means every one of those 9 modules'
  catalog permissions legitimately shows as `orphaned` today — an honest
  reflection of incomplete descriptor metadata, not a real drift/incident.
  Backfilling every other module's `permissions` array is out of scope
  here (the issue itself says this metadata is "optional... if not
  completed in Issue 1" — #511 didn't do it for the pre-existing modules,
  and this issue's job is the comparison service, not that backfill).
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

## Module health/readiness — `application/health-registry.ts` (Issue #520)

`GET /api/v1/modules/{moduleKey}/health` (fast, bounded, `module_management.health.read`)
and `POST /api/v1/modules/{moduleKey}/health/check` (explicit/on-demand,
`module_management.health.check`, audited as `action: "health_checked"`).
`domain/health-registry.ts`'s `classifyHealthStatus` (pure) aggregates a
list of `ReadinessSignal`s (`pass`/`fail`/`not_applicable`) into one of
`healthy`/`degraded`/`failed`/`unknown`.

**Generic signals, computed identically for every module** (both `GET`
and `POST` run these):

- `descriptor_registered` — always `pass` (we only get this far if it is).
- `db_registry_synced` — the `awcms_mini_modules` row's `lifecycle_status`
  matches the descriptor's own `status`.
- `migrations_applied` — every `sql/*.sql` file has a matching
  `awcms_mini_schema_migrations` row. A **local, minimal re-listing** of
  migration filenames, not an import of `scripts/db-migrate.ts`'s own
  `discoverMigrationFiles` — importing from `scripts/` into `src/` would
  be a backwards dependency, and that function's checksum/transaction-control
  validation isn't needed for a read-only readiness check.
- `permission_catalog_synced` — reuses Issue #517's `comparePermissions`;
  fails only on `missing`/`mismatched_description` entries (an `orphaned`
  entry isn't this module's fault, so it doesn't count against it).
- `settings_valid` — reuses Issue #516's `fetchModuleSettingsView`; `pass`
  if it resolves without throwing (no required-field validation exists
  yet to fail against).
- `jobs_documented` — reuses Issue #519's `fetchModuleJobs` +
  `validateJobDescriptor`; `not_applicable` if the module declares no
  jobs at all.
- `openapi_documented` / `asyncapi_documented` — `not_applicable` unless
  the descriptor declares `api`/`events`; otherwise checks the referenced
  YAML file actually documents the module's `basePath`/published events.

**`provider_health_check` — the one deliberately module-specific
signal**, `POST` only: `not_applicable` for every module except `email`,
where it calls the real `resolveEmailProvider().healthCheck()` (Issue
#495 — already timeout-bounded, error-truncating, the same function
`bun run email:provider:health` uses). This mirrors an existing precedent
rather than inventing a new one: `scripts/security-readiness.ts` already
names `email`'s provider-config check specifically inside an otherwise
generic/shared script.

**Never leaks secrets**: every signal's `detail` is a small set of fixed,
generic strings (counts and static phrases) — never a raw error message,
stack trace, or `DATABASE_URL`. Every `catch` logs the real error
server-side via `log()` (which redacts defensively anyway) before
returning the safe, generic `detail`.

**`awcms_mini_module_health_checks` (migration 025) is written only by
`POST .../health/check`, never `GET .../health`.** Found and fixed during
Issue #522's documentation pass — migration 025 already provisioned this
table explicitly for Issue #520 ("Health check result history"), but the
original #520 implementation never wrote to it. `runModuleHealthCheck`
now inserts one row per explicit check (`module_key`, `status`, a safe
`message` built from failed signal _names_ only — never a signal's own
`detail` text). That table has an FK to `awcms_mini_modules`, so `POST`
also syncs the registry first (same reasoning as
`tenant-module-lifecycle.ts`/`module-settings.ts`) — the one place
`db_registry_synced` can genuinely read differently between `GET` and
`POST` for the same module.

## Admin UI (Issue #521)

`/admin/modules` (list — replaces #518's minimal stub) and
`/admin/modules/{moduleKey}` (full detail) — the last issue in epic #510.

- **List**: catalog table + client-side type/status/health filters (pure
  `data-*` attribute show/hide — only 10 modules exist in this base, a
  server round-trip per filter change would be pure overhead) + a health
  status column (every module's `fetchModuleHealthReport`, #520, computed
  in parallel — each check is individually cheap/bounded by design, and
  this only runs on an explicit admin page load).
- **Detail**: dependency panel, tenant enable/disable action, settings
  panel, permission sync/status panel, navigation panel, jobs panel,
  health/readiness panel (+ explicit `POST .../health/check` trigger
  button), and a lifecycle/audit summary
  (`application/module-audit-summary.ts` — a new, small, read-only query
  over `awcms_mini_audit_events` scoped to the module-management actions
  that target this specific module: `tenant_module_enabled`/`_disabled`
  #515, `settings_updated` #516, `health_checked` #520).
- **Every panel is permission-gated to its own endpoint's guard exactly**
  (defense-in-depth — hiding a control here is a UX nicety, the real
  enforcement is server-side): `module_management.navigation.read` gets
  its first real consumer here (seeded since #512/#518's own doc note
  flagged it as otherwise unused).
- **All mutations go through the real API endpoints via client-side
  `fetch`** (`POST .../enable`, `POST .../disable`, `PATCH .../settings`,
  `POST .../health/check`) — this page has no privileged shortcut, same
  as every other admin screen in this app (`admin/access-users.astro`,
  `admin/sync.astro`). Anti double-submit via the shared
  `lib/ui/admin-form-client.ts` helpers (`lockElement`); disable prompts
  for a reason via `window.prompt` (same established pattern as
  `admin/access-users.astro`'s role delete).
- **Settings panel edits only the tenant override**, never `defaults`
  (read-only, code-declared) — the same secret-shaped-key rejection
  #516's `PATCH` endpoint already enforces applies here too, since this
  form calls that exact endpoint.

## Out of scope (epic #510)

Marketplace, runtime plugin upload, running arbitrary jobs from the UI,
editing raw secrets, and a complex graph visualization library are
explicitly out of scope for the admin UI (Issue #521's own out-of-scope
list) — and for the epic as a whole, per #510's own out-of-scope list:
runtime upload/install of arbitrary third-party code, a marketplace, a
remote module repository, and dynamic import from untrusted paths.
