# Runtime Configuration

## Purpose

This document defines the base runtime configuration contract for the AWCMS Mini scaffold.

## Current Runtime Settings

### `DATABASE_URL`

- Purpose: PostgreSQL connection string used by the EmDash database adapter.
- Scope: server-only runtime configuration.
- Example: `postgres://localhost:5432/awcms_mini_dev`
- Default fallback: `postgres://localhost:5432/awcms_mini_dev`

## Source of Truth

- runtime config module: `src/config/runtime.mjs`
- Astro integration wiring: `astro.config.mjs`
- local environment example: `.env.example`

## Rules

- keep runtime connection settings isolated in `src/config/`
- do not inline database connection strings across multiple files
- do not introduce Supabase-specific environment variables
- treat `DATABASE_URL` as the canonical PostgreSQL runtime input

## Validation

- `pnpm typecheck`
- `pnpm build`
- local boot or build smoke test with the configured `DATABASE_URL`
