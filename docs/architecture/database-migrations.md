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

## Source of Truth

- runner script: `scripts/db-migrate.mjs`
- db client: `src/db/client/postgres.mjs`
- migration runner module: `src/db/migrations/runner.mjs`
- migration files: `src/db/migrations/*.mjs`

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

## Runtime Input

- `DATABASE_URL` is required to target the PostgreSQL database
- the runner loads `.env` and `.env.local` automatically when available

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
