# Database Migrations

## Purpose

This document defines the canonical migration runner workflow for AWCMS Mini.

## Current Migration Commands

- `pnpm db:migrate`
  - applies pending migrations to the configured PostgreSQL database
- `pnpm db:migrate:down`
  - rolls back the most recently applied migration
- `pnpm db:migrate:status`
  - prints applied and pending migration names
- `pnpm db:migrate:emdash:status`
  - inspects the EmDash `_emdash_migrations` ledger and reports whether the current Mini compatibility prefix is compatible, repairable, or unsafe
- `pnpm db:migrate:emdash:repair`
  - rewrites `_emdash_migrations` only when the current rows are a repairable permutation of the expected Mini compatibility prefix

## Source of Truth

- runner script: `scripts/db-migrate.mjs`
- db client: `src/db/client/postgres.mjs`
- migration runner module: `src/db/migrations/runner.mjs`
- migration files: `src/db/migrations/*.mjs`
- EmDash compatibility ledger helper: `src/db/migrations/emdash-compatibility.mjs`

## Current Bootstrap State

- the initial migration is `001_baseline`
- `001_baseline` is an intentional no-op bootstrap migration
- `002_users` introduces the canonical user identity table
- `003_user_profiles` introduces the one-to-one non-auth user profile table
- `004_sessions` introduces active and historical authenticated session tracking
- `005_login_security_events` introduces append-only login and auth attempt history
- `006_soft_delete_identity_records` adds soft delete markers for mutable identity records
- `007_emdash_auth_compatibility` adds minimum compatibility columns needed by EmDash auth middleware
- `008_emdash_runtime_bootstrap` adds EmDash runtime support tables needed by the shared admin/setup path without replaying EmDash's incompatible auth migrations over Mini's `users` table
- `009_user_invite_tokens` adds repo-owned invite activation token storage for invited-user activation
- `010_roles` adds the RBAC role catalog with `staff_level`, protection metadata, unique role slug, and soft-delete markers
- `011_permissions` adds the RBAC permission catalog with unique permission codes, protected markers, and code-format enforcement
- `012_role_permissions` adds the RBAC role-to-permission mapping with composite uniqueness and grant metadata
- `013_user_roles` adds effective-dated user role assignments with primary-role support and partial unique indexes for active-role enforcement
- `032_edge_api_permissions` adds canonical self-service edge API permission entries and role grants for the current `/api/v1/session` baseline so protected edge routes use the shared authorization model
- `031_soft_delete_operator_attribution_catalogs` adds `deleted_by_user_id` and `delete_reason` to operator-managed logical-region and job-catalog tables so soft delete attribution matches the established user and role contract
- `034_emdash_compatibility_support_tables` backfills the missing upstream EmDash runtime support tables Mini needs for compatibility work and seeds the canonical `001` through `009` `_emdash_migrations` prefix when the EmDash ledger is still empty

## Current EmDash Runtime Caveat

- The current live Cloudflare setup path now relies on a shared EmDash-side `/_emdash/api/setup/status` database fallback instead of the earlier Mini-only middleware override, but issue `#180` remains open until the broader runtime initialization path stops colliding with the Mini-owned schema and ledger.
- The current repo now backfills the missing upstream support tables and seeds the canonical EmDash compatibility prefix only when `_emdash_migrations` is still empty, so fresh Mini-owned environments stop replaying `001_initial` blindly over the existing schema before the later runtime-compatibility work lands.
- The underlying EmDash runtime initialization path is still colliding with Mini's existing PostgreSQL schema and `_emdash_migrations` ledger when it tries to reconcile upstream core migrations against the Mini-owned bootstrap.
- Confirmed live failure signatures during issue `#180` investigation include:
  - `Migration failed: column "actor_id" does not exist (migration: 001_initial)`
  - `corrupted migrations: expected previously executed migration 003_schema_registry to be at index 1 but 002_media_status was found in its place`
- Treat any direct mutation of `_emdash_migrations` as issue-scoped operator work with explicit rollback notes. Do not ad hoc edit the migration ledger during routine deploys.
- The repository now includes a deterministic compatibility helper for the expected Mini-owned EmDash migration prefix so issue `#180` can validate ordering and timestamp-seeding logic in unit tests before any future live ledger repair step.
- The repo-owned migration CLI now exposes explicit `emdash-status` and `emdash-repair` commands for issue-scoped operator use. `emdash-repair` only runs when the persisted ledger is a reorder-only mismatch within the expected Mini compatibility prefix and refuses unexpected migration names.
- When a migration command cannot reach or initialize the reviewed database target, the CLI now prints a non-secret database error `kind`, `reason`, and message so operators can distinguish timeout, DNS, TLS, authentication, and Hyperdrive-binding blockers before retrying.

## Runtime Input

- `DATABASE_URL` is required to target the PostgreSQL database
- the runner uses `scripts/_local-env.mjs` to load `.env.local` first, then `.env`, so local-only values stay ahead of tracked defaults when using Node's `process.loadEnvFile()` behavior

## Usage

### Apply Pending Migrations

```bash
pnpm db:migrate
```

### Roll Back One Migration

```bash
pnpm db:migrate:down
```

### Check Migration Status

```bash
pnpm db:migrate:status
```

### Inspect EmDash Ledger Compatibility

```bash
pnpm db:migrate:emdash:status
```

### Repair EmDash Ledger Ordering

```bash
pnpm db:migrate:emdash:repair
```

## Rules

- use Kysely migrations as the canonical schema change mechanism
- keep migration files ordered and descriptive
- use `Kysely<any>` in migration files when table migrations start landing
- do not introduce ad hoc schema changes outside migrations
- do not bypass PostgreSQL for first-party schema state

## Validation

- `pnpm db:migrate`
- `pnpm db:migrate:status`
- `pnpm db:migrate:down`
- `pnpm db:migrate:status`
