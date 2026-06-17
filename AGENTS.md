# AI Agent Guidance

This file provides repository-local guidance to AI coding agents working in AWCMS Mini.

## Documentation Authority

All agent work must respect this order:

1. `REQUIREMENTS.md`
2. `AGENTS.md`
3. `README.md`
4. `DOCS_INDEX.md`
5. focused implementation and operator docs under `docs/**`

If a lower-priority document conflicts with a higher-priority one, follow the higher-priority document.

## Project Shape

AWCMS Mini is:

- EmDash-first
- single-tenant
- PostgreSQL-backed
- Kysely-based
- governance-overlay focused

It is not:

- a multi-tenant platform
- a Supabase-based runtime
- a second admin shell outside EmDash
- a replacement for EmDash core architecture

## Core Execution Rules

1. Extend EmDash; do not recreate a parallel platform core.
2. Keep Mini-specific work in governance overlays, services, plugins, and admin extensions.
3. Prefer explicit service-layer enforcement over UI-only logic.
4. Use shared plugin helpers in `src/plugins/` instead of duplicating permission, auth, audit, or region-scoping logic.
5. Keep jobs, roles, logical regions, and administrative regions as separate concepts.

## Plugin Contract Rules (ADR-018)

Every plugin MUST:

1. Provide a `manifest.json` that passes `validatePluginManifest()` from `src/plugins/manifest.mjs`.
2. Set `kind: "awcms-mini-plugin"` and `data.adapter: "postgres"`, `data.rls: "required"`.
3. Declare all permissions using namespace `awcms:{module}:{resource}:{action}`.
4. Include a `migrate.mjs` that calls `buildPluginRlsStatements()` for every table it creates.
5. Use `createPluginRepository()` from `src/db/plugin-adapter.mjs` — never raw Kysely without schema scoping.
6. Be registered via `src/plugins/loader.mjs` → `ACTIVE_PLUGINS`.

**Security constraints (hard rules):**
- NIK and other highly-restricted identifiers must be encrypted before DB write — store `nik_enc`, never `nik`.
- `nik_enc` must be stripped from output by default (reveal only via audited endpoint).
- File binaries go to R2 — never store in DB columns. Store only `r2_key` (path, not URL).
- Do not expose raw R2 keys or URLs to clients.

## RLS Rules (ADR-015)

- RLS is enforced on all per-user tables via migration `040_rls_per_user_tables.mjs`.
- All plugin tables require RLS via `buildPluginRlsStatements()` in their `migrate.mjs`.
- The `server/middleware/db-context.mjs` sets `app.current_user_id` and `app.is_admin` per request.
- `app.is_admin = 'true'` is set for actors with `staff_level >= 7` (admin bypass for listing operations).
- Run `pnpm check:rls-coverage` (FF6) to verify RLS is active on all required tables.

## Required Reading By Task Type

### Governance Or Security Work

Read:

1. `docs/architecture/constraints.md`
2. `docs/architecture/overview.md`
3. relevant docs under `docs/governance/` and `docs/security/`

### Plugin Work

Read:

1. `src/plugins/manifest.mjs` — kontrak manifest + validator (ADR-018)
2. `src/db/plugin-adapter.mjs` — base repository + RLS helper + konteks DB
3. `src/plugins/registry.mjs` — register, seed permission, list plugin
4. `src/plugins/loader.mjs` — ACTIVE_PLUGINS (tambahkan entry plugin baru di sini)
5. `src/plugins/sikesra/` — contoh plugin nyata pertama (referensi implementasi)
6. `src/plugins/internal-governance-sample/index.mjs` — contoh plugin lama (pola definePlugin)

### Admin Work

Read:

1. `docs/admin/operations-guide.md`
2. `src/plugins/awcms-users-admin/index.mjs`
3. `src/plugins/awcms-users-admin/admin.tsx`

### Documentation Work

Read:

1. `docs/README.md`
2. `skills/awcms-mini-docs/SKILL.md`

## Current Repository Skills

- `skills/awcms-mini-governance-overlay/SKILL.md`
- `skills/awcms-mini-docs/SKILL.md`

Use them when the task matches their scope.

## Validation Guidance

- Use targeted unit tests first.
- Run `bun run typecheck` for UI or TypeScript-adjacent work.
- Run `bun run test:unit` when a change touches shared behavior.
- Review operator impact against:
  - `docs/process/migration-deployment-checklist.md`
  - `docs/security/emergency-recovery-runbook.md`

## Current Accuracy Notes

Agents should not overstate the current implementation.

In particular:

- staged mandatory 2FA rollout configuration exists, but enforcement/persistence should be treated carefully and verified against current runtime behavior before documenting it as fully complete
- ABAC audit-only rollout exists and should be documented as a rollout tool, not a permanent policy mode
- the current deployment baseline is Cloudflare-delivered frontend traffic plus Hono on Coolify, with PostgreSQL accessed only through the backend API
- the reviewed Coolify-managed VPS now uses key-only root SSH recovery and no longer treats password-based root SSH as the normal recovery path

## Workflow Note

The repository has historically followed an issue-driven workflow, but there may be moments when no open GitHub issue exists for a new local-docs or housekeeping request. In those cases, still keep changes atomic and well-scoped.
