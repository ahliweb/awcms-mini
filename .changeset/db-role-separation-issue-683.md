---
"awcms-mini": minor
---

Add Postgres least-privilege role separation for background workers and the
setup wizard (Issue #683, epic #679, platform-hardening).

Migration 013's `awcms_mini_app` role has blanket `SELECT/INSERT/UPDATE/
DELETE` on every `awcms_mini_*` table — correct for the ~76 tenant-scoped
tables (RLS `ENABLE`+`FORCE` is the real isolation boundary there, ADR-0003),
but it also reaches 9 GLOBAL (non-RLS) tables: the permission catalog, the
migration ledger, the setup-state lock, the tenant root table, and the
module registry + 4 dependents. The same role that serves every ordinary
tenant web request had unrestricted write access to data no ordinary
request should ever touch.

New migration `sql/045_awcms_mini_db_role_separation.sql` adds two optional
roles alongside the migration-owner/`awcms_mini_app` pair:

- `awcms_mini_worker` (`WORKER_DATABASE_URL`) — the 7 unattended cron-style
  scripts with no HTTP endpoint (`analytics:rollup`, `analytics:purge`,
  `logs:audit:purge`, `sync:objects:dispatch`, `email:dispatch`,
  `blog:publish:scheduled`, `form-drafts:purge`). Zero access to the 9
  global tables except `SELECT` on `awcms_mini_tenants`.
- `awcms_mini_setup` (`SETUP_DATABASE_URL`) — only
  `POST /api/v1/setup/initialize`. Defense-in-depth on top of the existing
  `awcms_mini_setup_state` singleton lock, not a replacement for it.

`awcms_mini_app` itself is narrowed on the 9 global tables to exactly what
ordinary requests legitimately write (module registry sync/health-check
endpoints keep full DML; the permission catalog, migration ledger, and
setup-state lock become read-only or lose write entirely; the tenant root
table keeps `UPDATE` for `PATCH /api/v1/settings` but loses `INSERT`/
`DELETE`).

Both new roles are optional — `WORKER_DATABASE_URL`/`SETUP_DATABASE_URL`
fall back to `DATABASE_URL` (the narrowed `awcms_mini_app` role) when unset,
so existing deployments keep working with zero config changes and still
get the narrower `awcms_mini_app` grants.

New regression guard: `bun run security:readiness`'s
`checkRuntimeRoleGlobalTableGrants` (critical) reads the real grants from
`pg_class.relacl` and fails go-live if a future migration accidentally
grants a runtime role unexpected access to one of the 9 global tables.

New integration tests
(`tests/integration/db-role-separation.integration.test.ts`) connect as
each of the three runtime roles against a real Postgres and assert the
actual permission-denied/succeeds outcome — this caught a real bug during
development: `INSERT ... RETURNING id` requires `SELECT` privilege on the
returned column, not just `INSERT`, so `awcms_mini_setup` needed `SELECT`
added on every table `bootstrapPlatformTenant` inserts into with
`RETURNING id`.
