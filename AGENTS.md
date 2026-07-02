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

- single-tenant
- own stack: **Astro + Hono + PostgreSQL** (pg + Kysely), runtime **Bun**
- governance-overlay focused
- **EmDash = rujukan arsitektur saja** (ADR-020; paket `emdash` dilepas bertahap via seam `src/cms/`)

It is not:

- a multi-tenant platform
- a Supabase-based runtime
- SQLite-based (PostgreSQL-only)
- bergantung pada paket `emdash` sebagai host/runtime (target: lepas penuh)

## Core Execution Rules

1. **EmDash = rujukan arsitektur saja (ADR-020)** — paket `emdash` sedang dilepas bertahap (epic decoupling). **DILARANG** menambah `import ... from "emdash"` baru di luar seam `src/cms/`. Pakai stack sendiri (Astro + Hono + PostgreSQL).
2. Keep Mini-specific work in governance overlays, services, plugins, and admin extensions.
3. Prefer explicit service-layer enforcement over UI-only logic.
4. Use shared plugin helpers in `src/plugins/` instead of duplicating permission, auth, audit, or region-scoping logic.
5. Keep jobs, roles, logical regions, and administrative regions as separate concepts.

## Toolchain & Runtime (ADR-019)

- Package manager + runtime = **Bun** (`bun install`, `bun run`, `bun server/index.mjs`; Docker `oven/bun:1-alpine`).
- **Test runner = `node --test`** (bukan `bun test` — belum dukung nested `node:test`, bun#5090). Dev/CI menyediakan Node bersama Bun.
- **PostgreSQL-only** — tidak ada SQLite (better-sqlite3 hanya transitif via emdash, dilepas saat Fase 5).

## Concurrency (#360)

- **DILARANG** pola `SELECT` → logika aplikasi → `UPDATE` tanpa lock/atomic update pada write kritikal (approval, status, counter/kuota, penomoran, provisioning).
- Prefer **atomic update** / **guarded status transition** (expected status di `WHERE`) / **`ON CONFLICT`** UPSERT. Butuh validasi kompleks → `SELECT ... FOR UPDATE`.
- Resource logis (numbering, provisioning) → advisory lock via `withAdvisoryXactLock` + `buildAdvisoryLockKey`. Invariant lintas-tabel → `withSerializableRetry`. Helper di `src/db/concurrency.mjs` (re-export dari `src/db/index.mjs`).
- Jangan `MAX(number)+1` untuk penomoran. Standar lengkap: `docs/security/database-concurrency.md`.

## Logging (ADR-021)

- Gunakan **Pino** via `src/observability/logger.mjs` (`rootLogger`, `childLoggerForRequest`). Jangan `console.*` ad-hoc di jalur HTTP.
- Child logger ber-`requestId` (lihat `server/middleware/logger.mjs`).
- **Redaction wajib** field sensitif (password/token/secret/NIK/header auth) — sudah dikonfigurasi di logger.

## Search / CQRS (ADR-023)

- Pencarian = **query side terpisah** (read-only) di `src/search/` + `src/plugins/<x>/search/`. Jangan campur ke repository CRUD.
- Pakai `normalizeSearchQuery`/`buildSearchResult` dari `src/search/query-contract.mjs` (paginasi + sort whitelist anti-injection).
- Kembalikan **read DTO/projection** (bukan entity). Field sensitif (`password_hash`, `nik_enc`, `metadata`, nilai `ihs_number`) **tidak pernah** keluar dari search.
- Data sensitif: sediakan hook audit (`onAudit`). Skala besar → OpenSearch di balik kontrak query yang sama (PostgreSQL bila belum besar).

## EmDash Seam (ADR-020, decoupling)

- Semua akses runtime EmDash lewat seam `src/cms/` (`context.mjs`, `plugin-runtime.mjs`). Lihat `src/cms/README.md`.
- Fitness guard: `tests/unit/cms-seam.test.mjs` gagal bila ada import `emdash` langsung di luar `src/cms/`.
- Touchpoint tersisa (`emdash/*` subpath) terinventaris di `docs/architecture/emdash-touchpoint-inventory.md`.

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
- Run `bun run check:rls-coverage` (FF6) to verify RLS is active on all required tables.

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
