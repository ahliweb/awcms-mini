# Runtime Configuration

## Purpose

This document defines the base runtime configuration contract for the AWCMS Mini scaffold.

## Current Runtime Settings

### `DATABASE_URL`

- Purpose: PostgreSQL connection string used by the EmDash database adapter.
- Scope: server-only runtime configuration.
- Example: `postgres://localhost:5432/awcms_mini_dev`
- Default fallback: `postgres://localhost:5432/awcms_mini_dev`

### `MINI_TOTP_ENCRYPTION_KEY`

- Purpose: encryption key for TOTP secret storage.
- Scope: server-only runtime configuration.
- Fallback behavior: the current code falls back to `APP_SECRET` when this value is not provided.
- Rule: production deployments should set an explicit dedicated value instead of relying on an implicit fallback.

### Public Origin

- Purpose: define the canonical browser-facing origin for login, admin, and other origin-sensitive behavior when running behind Cloudflare and a reverse proxy.
- Current status: the code and docs need stronger alignment here with current EmDash `siteUrl`-style expectations.
- Rule: deployments behind Cloudflare and Coolify should treat public-origin correctness as a first-class runtime concern.

## Source of Truth

- runtime config module: `src/config/runtime.mjs`
- Astro integration wiring: `astro.config.mjs`
- local environment example: `.env.example`

## Rules

- keep runtime connection settings isolated in `src/config/`
- do not inline database connection strings across multiple files
- do not introduce Supabase-specific environment variables
- treat `DATABASE_URL` as the canonical PostgreSQL runtime input
- document security-sensitive secrets explicitly when code depends on them
- document public-origin and trusted-proxy assumptions explicitly for Cloudflare-fronted deployments
- for remote PostgreSQL deployments, prefer TLS-enabled connections and host-level access restriction

## Deployment Notes

### Cloudflare Plus Coolify

- Cloudflare should be treated as the browser-facing edge.
- Coolify should be treated as the app deployment and reverse-proxy control plane.
- The configured public origin must match the hostname users reach through Cloudflare, not an internal container or local Coolify address.

### PostgreSQL On VPS

- Production `DATABASE_URL` should point to the intended remote PostgreSQL instance.
- The database path should be treated as a remote secured dependency, not a localhost-only assumption.
- Prefer PostgreSQL TLS, restricted ingress, and strong authentication for the application user.

## Validation

- `pnpm typecheck`
- `pnpm build`
- local boot or build smoke test with the configured `DATABASE_URL`
