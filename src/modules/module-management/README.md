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

- **`fetchTenantModuleEntries(tx, tenantId)`** — every registered module's
  tenant-enabled state, for callers that genuinely need the full list (the
  `GET` endpoint above, tenant module presets, the tenant-module matrix
  admin UI).
- **`fetchTenantModuleEntry(tx, tenantId, moduleKey)`** — single-module
  narrowing added as a security audit follow-up (epic #555, flagged during
  Issue #560's review): a caller that only needs one module's state, like
  `blog-content`'s anonymous public `/news` gate
  (`public-news-tenant-resolution.ts`), was reading every registered
  module's row via the plural function — not a real DoS risk (one cheap
  indexed query, filtered in memory), but unnecessary read surface for a
  public, unauthenticated code path. This variant filters `module_key` in
  the `SQL` itself instead of filtering in memory, and returns `null` only
  if `moduleKey` isn't a registered descriptor at all. Same
  opt-out-by-default semantics as the plural function (no
  `awcms_mini_tenant_modules` row means `tenantEnabled: true`).

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
- **Secret-_shaped values_ are rejected too, regardless of key name**
  (`400 SETTINGS_SECRET_SHAPED_VALUE_REJECTED` — found during the epic #555
  security audit chain: key-name checking alone lets an admin paste a real
  credential into an innocently-named field like `publicLabel`, where it
  gets stored raw and returned as-is via `GET`). `_shared/redaction.ts`'s
  `findSecretShapedValues` checks every string value (recursively) against
  a deliberately conservative set of patterns — JWT (three base64url
  segments), a PEM private key block, an AWS access key id, a raw
  `Bearer `/`Basic ` header value, a connection string with an embedded
  `user:pass@` — chosen so ordinary labels/URLs/flags are never
  false-flagged. The rejection message names only the offending key
  _path_, never the value itself.
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
- **Only `module_management`, `blog_content`, and `tenant_domain`'s
  descriptors currently declare `permissions`** (`blog_content` added its
  full 36-entry array in Issue #543, closing epic #536; `tenant_domain`
  added a six-entry array in Issue #558, epic #555 — grep `permissions:`
  across `src/modules/*/module.ts` to confirm which modules declare it as
  code evolves, since this list has already grown twice). The other 9
  registered modules' permissions (email, form-drafts, identity-access,
  logging, profile-identity, reporting, sync-storage, tenant-admin,
  workflow-approval) were seeded directly by their own migrations, e.g.
  migration 005/010/014, without ever being added to their `module.ts`.
  This means every one of those 9 modules'
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
it. The registry-driven list is appended after those 4 — at the time
this was written it surfaced exactly one entry (`module_management`'s
own `/admin/modules`); `blog_content` (`/admin/blog`, Issue #543) and
`tenant_domain` (`/admin/tenant/domains`, Issue #563) have since added
their own `navigation` entries, so it now surfaces three (grep
`navigation:` across `src/modules/*/module.ts` to confirm the current
count as more modules add entries). A failure loading the registry (e.g.
a transient DB hiccup) falls back to
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
- `blog_content` — `blog:publish:scheduled` (Issue #541, epic #536 —
  publishes every due `status='scheduled'` post; idempotent, no external
  provider call, safe in any deployment profile).
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
  `data-*` attribute show/hide — only a dozen or so modules exist in this
  base (12 as of epic #555, see `src/modules/index.ts`'s `modules` array
  for the current count), a server round-trip per filter change would be
  pure overhead) + a health
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

## Tenant module presets — `domain/module-presets.ts` + `application/module-presets.ts` (Issue #565, epic #555)

Reusable named sets of modules matching an intended deployment profile
(`online_website`, `news_portal`, `saas_online`, `pos_lan`, `minimal`), so
a new tenant can be initialized with module availability that matches its
profile without an operator clicking through enable/disable one module at
a time. Domain + application service layer only in this issue — no new API
route or UI (`applyModulePreset(tx, tenantId, actorTenantUserId,
presetName)` is a plain callable function, meant to be called by a future
setup wizard step or tenant-admin flow, and by #566's tenant-module matrix
UI).

**Corrected module key**: the issue's own illustrative preset table used
`workflow_approval`, but the actually registered module key (the directory
is `workflow-approval`, the descriptor's `key` is `workflow`) is
`workflow`. Every preset definition here uses the real key, verified
against `listModules()` by `tests/unit/module-presets.test.ts`'s own
cross-check test — a wrong key would otherwise silently no-op (the
descriptor lookup returns nothing to act on) rather than fail loud.

**A preset both enables AND disables.** Applying a preset enables every
module it lists, and disables every currently-enabled module that isn't
listed and isn't "protected" (below). Only-ever-enabling would make
presets useless for reaching a coherent profile — a tenant that had
`blog_content` enabled before applying `minimal` would stay non-minimal
forever if presets never disabled anything. This makes preset application
a best-effort "make tenant module state match this profile" operation.

**"Protected" (core, for preset purposes) is computed, not hardcoded.**
Only `module_management` sets `isCore: true` in this registry today —
`tenant_admin`/`identity_access`/`profile_identity` don't, even though
they're just as foundational; their protection today comes purely from the
dependency graph's reverse-dependency check (nothing can disable
`identity_access` while `module_management`, which depends on it
transitively, remains enabled — and `module_management` itself can never
be disabled). `resolveProtectedModuleKeys` makes this explicit: `isCore`
keys unioned with the full transitive dependency closure of every `isCore`
key. In this repo that evaluates to `{module_management, tenant_admin,
identity_access, profile_identity}`. This is what lets `minimal` concretely
mean "enable nothing beyond this protected set, disable everything else
this tenant can safely give up" instead of an empty enable list that would
leave every previously-enabled module untouched.

**A preset-listed module's own missing dependency is never auto-enabled.**
If a preset lists a module whose dependency isn't itself in the preset (or
otherwise already enabled), this code does not invent resolution logic to
silently add it — the real `evaluateModuleEnable` semantics
(`MODULE_DEPENDENCY_MISSING`/`MODULE_DEPENDENCY_DISABLED`) are reused
as-is, and that failure is a real, reportable per-module outcome. In
practice this only matters cross-preset: e.g. `reporting` (listed by
`online_website`/`news_portal`/`saas_online`/`pos_lan`) depends on
`sync_storage` and `email`, neither of which every one of those presets
lists explicitly — a fresh tenant has every module enabled by default so
this never triggers on first apply, but if a _previous_ preset already
disabled one of those dependencies, the disable-planning below (leaves-first,
skip-not-force) actually prevents this from ever biting in practice: a
still-enabled `reporting` blocks its own dependencies from being
candidates for disabling in the first place (see next paragraph) — the
`MODULE_DEPENDENCY_DISABLED` path exists as a defensive fallback for the
general case, not because the five built-in presets are expected to hit it.

**Disabling is leaves-first and skip-not-force.** A module is only
disabled once nothing that stays enabled still depends on it (mirrors
exactly what the real, sequential `disableTenantModule` calls see as each
one lands). A module that can never become disableable — something that
stays enabled (core/protected, or another preset-listed module) still
depends on it — is reported in the result's `skipped` array with reason
`reverse_dependency_active`, never force-disabled and never silently
dropped. Concretely: applying `online_website` (lists `reporting` but not
`sync_storage`) leaves `sync_storage` enabled and reports it `skipped`,
because `reporting` — which stays enabled — depends on it.

**Idempotency**: `enableTenantModule`/`disableTenantModule` return a
`MODULE_ALREADY_ENABLED`/`MODULE_ALREADY_DISABLED` rejection when a module
is already in the target state — the domain plan (`computeModulePresetPlan`)
already excludes such modules from `toEnable`/`toDisable` in the first
place (nothing to attempt), so a clean re-application of the same preset
produces an empty plan and writes zero audit events. Any other rejection
code the real lifecycle validation returns (`MODULE_DEPENDENCY_MISSING`,
`MODULE_DEPENDENCY_DISABLED`, `CORE_MODULE_CANNOT_BE_DISABLED`,
`MODULE_REVERSE_DEPENDENCY_ACTIVE`) is surfaced as a genuine `rejected`
entry in the result's `changes` array — never silently swallowed.

**Audit**: one `tenant_module_enabled`/`tenant_module_disabled` event per
module actually changed (same action/resourceType as the manual
enable/disable endpoints), each tagged with `attributes.presetName` — never
one aggregate "preset applied" event, so an operator/auditor can see the
exact per-module state transitions a preset produced.

**Security**: never writes `awcms_mini_tenant_modules` directly — every
change goes through the real `enableTenantModule`/`disableTenantModule`.
Never touches `awcms_mini_roles`/`awcms_mini_role_permissions`/
`awcms_mini_access_assignments` — a preset changes module _availability_
only, never grants permissions (permission seeding is `bun run
modules:sync`'s job, already called internally by `enableTenantModule`).
`applyModulePreset` itself performs no auth/ABAC check — same division of
responsibility as `enableTenantModule`/`disableTenantModule` — the caller
(a future API route/setup wizard step) is responsible for
`authorizeInTransaction` before calling it.

Covered by `tests/unit/module-presets.test.ts` (pure domain planning
against both a synthetic registry and the real one) and
`tests/integration/module-presets.integration.test.ts` (real Postgres:
real row states, real audit events, idempotent re-application, and
switching between two different presets).

## Tenant-module matrix admin UI — `application/module-matrix.ts` (Issue #566, epic #555)

`/admin/modules/tenants` — a denser, module x relevant-attribute view for
**one tenant** on top of the same registry/lifecycle data #521's list/detail
pages already read, not a rebuild of either.

**Binding scope decision (single-tenant, not cross-tenant)**: the issue's
own wording ("filter by tenant", "managing module availability across
tenants") reads like a genuine multi-tenant matrix, but this repo's identity
model is strictly 1:1 tenant-scoped — `identity-access/README.md` documents
no cross-tenant linking anywhere in the schema, and
`src/components/TenantSwitcher.astro` is a permanently-disabled stub for
exactly this reason. Decided with the maintainer: this screen is scoped to
the admin's own tenant (`context.tenantId`), matching every other admin
screen in this app — there is no tenant selector/filter anywhere on this
page. Full reasoning: `src/pages/admin/modules/tenants.astro`'s own
docblock.

**What "matrix" concretely adds over #521's list+detail**, since there is no
second (tenant) axis to build a real grid against:

1. **Dependency/reverse-dependency warnings for every module at once**
   (`fetchModuleMatrix`'s `dependencyWarning`/`reverseDependencyWarning`) —
   100% reuse of `evaluateModuleEnable`/`evaluateModuleDisable` (#515), never
   a re-derived graph walk. `dependencyWarning` is only ever computed for a
   currently-**disabled** module (would enabling it succeed right now?,
   filtered to the dependency/version rejection codes); `reverseDependencyWarning`
   is only ever computed for a currently-**enabled** module (would disabling
   it right now be blocked because something still depends on it?, filtered
   to `MODULE_REVERSE_DEPENDENCY_ACTIVE`). Calling `evaluateModuleEnable` on
   an already-enabled module would only ever short-circuit to
   `MODULE_ALREADY_ENABLED` before reaching the dependency loop — asking it a
   question it isn't designed to answer for that state — so this
   deliberately does not attempt that direction; a currently-enabled
   module's dependencies are guaranteed satisfied by construction anyway
   (`disableTenantModule` already refuses to disable a dependency while an
   active dependent remains enabled).
2. **Core/protected visualization** — `isCore` and `isProtected`
   (`resolveProtectedModuleKeys`, #565) are both flagged per row, so an
   admin can bulk-see which modules are freely toggleable vs. structurally
   protected instead of discovering it one rejected click at a time on the
   detail page. The disable control is hidden for both — not just literal
   `isCore` — because a protected-but-non-core module's disable is always
   rejected server-side anyway (`MODULE_REVERSE_DEPENDENCY_ACTIVE`), so
   offering a guaranteed-to-fail button would be misleading (the issue only
   strictly requires blocking literal core modules; this goes slightly
   further as a UX nicety, never a security boundary — the endpoint enforces
   both ways regardless).
3. **A single "only show modules with a warning" client-side filter**, pure
   `data-*` show/hide like #521's own type/status filters — no equivalent on
   either existing page.

**Explicitly reused, not duplicated**: settings editing and the audit-event
list both already exist on `/admin/modules/{moduleKey}` — this screen only
links there (`admin.modules.view_detail_link`, same label #521's own list
page uses), it does not re-render either.

**Preset application (#565's `applyModulePreset`) is NOT wired into this
screen.** It was considered — this is the first plausible UI caller — but
doing so cleanly needs a new guarded/audited API endpoint (+ OpenAPI update,
its own ABAC guard, its own tests), which is large enough to be its own
atomic unit of work. Noted as a natural follow-up issue rather than
force-fit here.

**Binding split**: SSR reads are a direct, read-only `withTenant` call
(`fetchModuleMatrix`), same pattern as `admin/modules.astro`. Every mutation
(enable/disable) goes through the real `/api/v1/tenant/modules/{moduleKey}/enable|disable`
endpoints (#515) via client-side `fetch` — no privileged SSR shortcut,
same binding split `admin/tenant/domains.astro` (#563) established for this
epic. Neither endpoint requires an `Idempotency-Key` (confirmed by reading
both route files), so none is sent. Disable prompts for a reason via
`window.prompt` (same pattern as `admin/modules/[moduleKey].astro`'s
enable/disable buttons) — the real endpoint rejects an empty reason with
`400 VALIDATION_ERROR` regardless of what the UI does.

Gated on **both** `module_management.modules.read` AND
`module_management.tenant_modules.read` (the matrix intrinsically shows
tenant enablement, unlike the plain catalog list) — `module_management.health.read`
additionally gates the health column exactly like `admin/modules.astro`.

Covered by `tests/integration/module-tenant-matrix.integration.test.ts`
(real Postgres: `fetchModuleMatrix`'s health-inclusion toggle, both warning
directions using the same registry scenarios
`module-tenant-lifecycle.integration.test.ts` already established, core
protection, and the real enable/disable endpoints including a 403 for a
caller without permission). Client-side-only behavior (filters, the
StateNotice empty/error branches) has no browser/SSR render harness in this
repo (see `blog-content-admin-ui.integration.test.ts`'s own docblock) —
smoke-tested manually against a real dev server instead.

## Out of scope (epic #510)

Marketplace, runtime plugin upload, running arbitrary jobs from the UI,
editing raw secrets, and a complex graph visualization library are
explicitly out of scope for the admin UI (Issue #521's own out-of-scope
list) — and for the epic as a whole, per #510's own out-of-scope list:
runtime upload/install of arbitrary third-party code, a marketplace, a
remote module repository, and dynamic import from untrusted paths.
