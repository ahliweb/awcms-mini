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
