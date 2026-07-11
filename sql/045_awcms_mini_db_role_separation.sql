-- Issue #683 (epic #679, platform-hardening) — replace the single
-- blanket-DML `awcms_mini_app` role (migration 013) with least-privilege,
-- purpose-specific roles.
--
-- EVIDENCE (audit at repo revision 4b6ccfc): migration 013 grants `awcms_mini_app`
-- `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` — this
-- was correct for the ~76 tenant-scoped tables (RLS FORCE'd, so the DB-level
-- grant is coarse but row-level policy is the real boundary, per ADR-0003),
-- but it ALSO covers 9 GLOBAL tables that have NO row-level security at
-- all: `awcms_mini_permissions`, `awcms_mini_schema_migrations`,
-- `awcms_mini_setup_state`, `awcms_mini_tenants`, `awcms_mini_modules`,
-- `awcms_mini_module_dependencies`, `awcms_mini_module_navigation`,
-- `awcms_mini_module_jobs`, `awcms_mini_module_health_checks`. For those,
-- the single runtime role serving EVERY ordinary web request had
-- unrestricted DML on data (the permission catalog, the tenant root table,
-- the one-time setup lock) that ordinary requests never legitimately write.
--
-- FOUR roles now exist, matching the actual runtime actors in this codebase
-- (verified by grepping every write path, not assumed):
--
-- 1. Migration owner — unchanged. The existing superuser/table-owner role
--    `bun run db:migrate` connects as (`DATABASE_URL` on the CLI, never
--    committed). Only role that can `ALTER`/`DROP`/`CREATE` anything.
-- 2. `awcms_mini_app` ("web runtime") — kept (renaming would break every
--    existing deployment's `.env`), NARROWED, but only as far as the
--    optional-role fallback design (see the note below this list) allows.
--    Full DML on tenant-scoped (RLS FORCE'd) tables is unchanged — RLS is
--    the real boundary there, so the existing `ALTER DEFAULT PRIVILEGES`
--    convenience for FUTURE tenant-scoped tables is kept, see
--    `scripts/security-readiness.ts`'s `checkRuntimeRoleGlobalTableGrants`
--    for the regression guard that replaces "trust every future migration
--    remembers to narrow itself". On the 9 global tables: read-only on
--    `awcms_mini_permissions`/`awcms_mini_schema_migrations` (never
--    written by ANY runtime code path, dedicated OR fallback — verified by
--    grep, only migrations seed the former, only the migration runner
--    writes the latter, so these two are narrowed with no caveat); on
--    `awcms_mini_tenants`/`awcms_mini_setup_state`, DELETE is revoked
--    (nothing, dedicated or fallback, ever deletes a tenant or the
--    setup-state singleton) but INSERT/UPDATE/SELECT are KEPT — because
--    `getSetupDatabaseClient()` (`src/lib/database/client.ts`) falls back
--    to the `awcms_mini_app` connection when `SETUP_DATABASE_URL` isn't
--    set, so `POST /api/v1/setup/initialize` runs those exact statements
--    AS `awcms_mini_app` on any deployment that doesn't configure the
--    dedicated `awcms_mini_setup` role. Revoking them here would silently
--    break the setup wizard for every deployment that hasn't opted into
--    `SETUP_DATABASE_URL` — caught live by the full integration suite
--    (423 unrelated failures the first time this was attempted, every one
--    of them a fixture that bootstraps a tenant through the fallback
--    path). The practical consequence: `awcms_mini_app`'s isolation from
--    `awcms_mini_tenants`/`awcms_mini_setup_state` is real only once an
--    operator configures `SETUP_DATABASE_URL` — an explicit, documented
--    trade-off of the optional-role design, not an oversight. Full DML
--    kept on the module-registry tables (`awcms_mini_modules` + 3
--    dependents + health checks) — genuinely written at request time by
--    the permission-gated `POST /api/v1/modules/sync` and
--    `POST /api/v1/modules/{moduleKey}/health/check` endpoints, a
--    deliberate, tested exception, not an oversight.
-- 3. `awcms_mini_worker` ("background worker", NEW) — the 7 unattended
--    cron-style scripts that have NO corresponding web endpoint
--    (`analytics:rollup`/`analytics:purge`, `logs:audit:purge`,
--    `sync:objects:dispatch`, `email:dispatch`, `blog:publish:scheduled`,
--    `form-drafts:purge`). Granted DML on EXACTLY the tables each one
--    touches (verified per-script by reading the application code each
--    calls, not assumed) — zero access to any of the 9 global tables.
--    `bun run modules:sync` (the CLI form of the SAME
--    `syncModuleDescriptors` the web endpoint above calls) deliberately
--    stays on `awcms_mini_app`, not this role — it is the same actor/
--    capability as the web endpoint, not an unattended background job.
-- 4. `awcms_mini_setup` ("bootstrap/setup", NEW) — the ONE-TIME
--    `POST /api/v1/setup/initialize` wizard only
--    (`tenant-admin/application/platform-bootstrap.ts`). Granted exactly
--    the INSERT rights `bootstrapPlatformTenant` uses: create the tenant,
--    claim+update the setup-state lock, and create the tenant's owner
--    (settings/office/profile/identity/tenant_user/role/role_permissions/
--    access_assignments) — the tenant-scoped tables among these are
--    RLS-protected exactly as for `awcms_mini_app` (same policy, any role
--    that sets `app.current_tenant_id` correctly is subject to it). Also
--    granted SELECT on every one of those tables that
--    `bootstrapPlatformTenant` inserts into WITH a `RETURNING id` clause
--    (tenants/offices/profiles/identities/tenant_users/roles) — Postgres
--    requires SELECT on a column for it to appear in RETURNING, INSERT
--    alone is not sufficient (see the inline comment at grant #4 below).
--    Post-bootstrap, this role's power to create a SECOND tenant is inert
--    at the application layer (the setup-state singleton lock rejects any
--    further call with 403) — this role exists as defense-in-depth on top
--    of that lock, not instead of it: a stolen `awcms_mini_app` credential
--    can no longer create a rogue tenant even if the application-level
--    check were ever bypassed by a future bug.
--
-- Roles 3/4 are optional in the sense that `getWorkerDatabaseClient()`/
-- `getSetupDatabaseClient()` (`src/lib/database/client.ts`) fall back to
-- `DATABASE_URL` (the `awcms_mini_app` connection) when
-- `WORKER_DATABASE_URL`/`SETUP_DATABASE_URL` aren't set — small/offline
-- deployments that don't want to manage 4 connection strings still work
-- with zero config changes. This DOES mean the isolation benefit is
-- uneven across the 9 global tables: `awcms_mini_permissions`/
-- `awcms_mini_schema_migrations` are narrowed unconditionally (nothing
-- ever writes them at runtime, dedicated role or not), but
-- `awcms_mini_tenants`/`awcms_mini_setup_state` are only FULLY isolated
-- from `awcms_mini_app` once `SETUP_DATABASE_URL` is actually configured
-- (see the role-2 note above) — an explicit, documented trade-off, not an
-- inconsistency.

-- 1. Create the two new roles (idempotent, mirrors migration 013's pattern).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_mini_worker') THEN
    CREATE ROLE awcms_mini_worker NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_mini_setup') THEN
    CREATE ROLE awcms_mini_setup NOLOGIN;
  END IF;
END
$$;

-- Same fail-closed default tenant GUC as `awcms_mini_app` (migration 013) —
-- a query against an RLS FORCE'd table that somehow runs without an
-- explicit `SET LOCAL app.current_tenant_id` (i.e. outside `withTenant`)
-- matches the all-zero UUID, never a real tenant.
ALTER ROLE awcms_mini_worker SET app.current_tenant_id = '00000000-0000-0000-0000-000000000000';
ALTER ROLE awcms_mini_setup SET app.current_tenant_id = '00000000-0000-0000-0000-000000000000';

GRANT USAGE ON SCHEMA public TO awcms_mini_worker;
GRANT USAGE ON SCHEMA public TO awcms_mini_setup;

-- 2. Narrow `awcms_mini_app` on the 9 global (non-RLS) tables. Every
-- tenant-scoped (RLS FORCE'd) table's grant from migration 013 is
-- UNCHANGED — RLS remains the real isolation boundary there, per ADR-0003.
REVOKE INSERT, UPDATE, DELETE ON awcms_mini_permissions FROM awcms_mini_app;
REVOKE INSERT, UPDATE, DELETE ON awcms_mini_schema_migrations FROM awcms_mini_app;
-- setup_state/tenants: only DELETE is revoked. INSERT/UPDATE/SELECT stay —
-- the awcms_mini_setup fallback path needs them (see header note #2).
REVOKE DELETE ON awcms_mini_setup_state FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_tenants FROM awcms_mini_app;
-- `awcms_mini_modules`/`_module_dependencies`/`_module_navigation`/
-- `_module_jobs`/`_module_health_checks` KEEP their existing full DML grant
-- (genuine, tested, permission-gated request-time write paths — see header).

-- 3. `awcms_mini_worker` — exactly the tables each of the 7 unattended
-- scripts touches (verified per-script against the application code each
-- calls). No grant at all on any of the 9 global tables.
GRANT SELECT ON awcms_mini_tenants TO awcms_mini_worker;
GRANT SELECT, DELETE ON awcms_mini_visit_events TO awcms_mini_worker;
-- UPDATE is required, not just SELECT/DELETE: purgeVisitorAnalyticsData's
-- raw-detail-clear step (retention-purge.ts) does
-- `UPDATE awcms_mini_visitor_sessions SET ip_address = NULL, ... RETURNING id`
-- before the later DELETE step — caught live by PR #703 review (reproduced
-- against real Postgres: without UPDATE, the whole per-tenant purge
-- transaction rolled back, silently defeating the PII-retention job).
GRANT SELECT, UPDATE, DELETE ON awcms_mini_visitor_sessions TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_mini_visitor_daily_rollups TO awcms_mini_worker;
GRANT SELECT, INSERT, DELETE ON awcms_mini_audit_events TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_object_sync_queue TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_email_messages TO awcms_mini_worker;
GRANT SELECT, INSERT ON awcms_mini_email_delivery_attempts TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_email_suppression_list TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_blog_posts TO awcms_mini_worker;
-- UPDATE is required, not just SELECT/DELETE: expireOverdueFormDrafts
-- (form-draft-purge.ts, step 1) does
-- `UPDATE awcms_mini_form_drafts SET status = 'expired' ... RETURNING id`
-- before purgeExpiredFormDrafts' later DELETE step — same class of bug as
-- awcms_mini_visitor_sessions above, caught by the same PR #703 review pass.
GRANT SELECT, UPDATE, DELETE ON awcms_mini_form_drafts TO awcms_mini_worker;

-- 4. `awcms_mini_setup` — exactly what `bootstrapPlatformTenant` writes.
-- SELECT is added alongside INSERT on every table it inserts into WITH a
-- `RETURNING id` clause (tenants/offices/profiles/identities/tenant_users/
-- roles) — Postgres requires SELECT privilege on a column for it to appear
-- in a RETURNING list, INSERT privilege alone is not enough (caught live by
-- tests/integration/db-role-separation.integration.test.ts before this was
-- ever deployed: RETURNING id failed with "permission denied" under
-- INSERT-only grants). RLS still confines each SELECT to the single tenant
-- `bootstrapPlatformTenant` just created in that same transaction (it sets
-- `app.current_tenant_id` right after creating the tenant row), so this is
-- not a broader read grant than the role's purpose requires.
GRANT SELECT, INSERT, UPDATE ON awcms_mini_setup_state TO awcms_mini_setup;
GRANT SELECT, INSERT ON awcms_mini_tenants TO awcms_mini_setup;
GRANT SELECT ON awcms_mini_permissions TO awcms_mini_setup;
GRANT INSERT ON awcms_mini_tenant_settings TO awcms_mini_setup;
GRANT SELECT, INSERT ON awcms_mini_offices TO awcms_mini_setup;
GRANT SELECT, INSERT ON awcms_mini_profiles TO awcms_mini_setup;
GRANT SELECT, INSERT ON awcms_mini_identities TO awcms_mini_setup;
GRANT SELECT, INSERT ON awcms_mini_tenant_users TO awcms_mini_setup;
GRANT SELECT, INSERT ON awcms_mini_roles TO awcms_mini_setup;
GRANT INSERT ON awcms_mini_role_permissions TO awcms_mini_setup;
GRANT INSERT ON awcms_mini_access_assignments TO awcms_mini_setup;
