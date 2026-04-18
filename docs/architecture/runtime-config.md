# Runtime Configuration

## Purpose

This document defines the base runtime configuration contract for the AWCMS Mini scaffold.

## Current Runtime Settings

### `DATABASE_URL`

- Purpose: PostgreSQL connection string used by the EmDash database adapter.
- Scope: server-only runtime configuration.
- Example: `postgres://localhost:5432/awcms_mini_dev`
- Default fallback: `postgres://localhost:5432/awcms_mini_dev`
- Production guidance: point this to the remote PostgreSQL host for the environment and prefer TLS-capable connection settings for app-to-database traffic.
- Role guidance: do not use PostgreSQL superuser credentials for the normal app runtime.

### `MINI_TOTP_ENCRYPTION_KEY`

- Purpose: encryption key for TOTP secret storage.
- Scope: server-only runtime configuration.
- Fallback behavior: the current code falls back to `APP_SECRET` when this value is not provided.
- Rule: production deployments should set an explicit dedicated value instead of relying on an implicit fallback.

### `APP_SECRET`

- Purpose: shared application secret available to the runtime.
- Scope: server-only runtime configuration.
- Current Mini usage: fallback for TOTP secret encryption when `MINI_TOTP_ENCRYPTION_KEY` is not set.
- Rule: do not rely on `APP_SECRET` as the steady-state TOTP key in production when a dedicated `MINI_TOTP_ENCRYPTION_KEY` can be provided.

### `SITE_URL`

- Purpose: define the canonical browser-facing origin for login, admin, canonical links, and other origin-sensitive runtime behavior.
- Current implementation: `astro.config.mjs` maps this to Astro's `site` setting when present.
- Format: absolute URL such as `https://cms.example.com`.
- Rule: deployments behind Cloudflare and Coolify should treat public-origin correctness as a first-class runtime concern.

### `TRUSTED_PROXY_MODE`

- Purpose: define which proxy path is trusted for client IP extraction.
- Supported values: `direct`, `cloudflare`, `forwarded-chain`.
- Default fallback: `direct`.
- Rule: Cloudflare plus Coolify deployments should set `TRUSTED_PROXY_MODE=cloudflare` so auth, audit, and lockout flows use `CF-Connecting-IP`.

## Source of Truth

- runtime config module: `src/config/runtime.mjs`
- Astro integration wiring: `astro.config.mjs`
- local environment example: `.env.example`
- TOTP encryption key resolution: `src/services/security/two-factor.mjs`

## Rules

- keep runtime connection settings isolated in `src/config/`
- do not inline database connection strings across multiple files
- do not introduce Supabase-specific environment variables
- treat `DATABASE_URL` as the canonical PostgreSQL runtime input
- document security-sensitive secrets explicitly when code depends on them
- prefer a dedicated `MINI_TOTP_ENCRYPTION_KEY` over the `APP_SECRET` fallback for TOTP secret encryption
- document public-origin and trusted-proxy assumptions explicitly for Cloudflare-fronted deployments
- for remote PostgreSQL deployments, prefer TLS-enabled connections and host-level access restriction

## Deployment Notes

### Cloudflare Plus Coolify

- Cloudflare should be treated as the browser-facing edge.
- Coolify should be treated as the app deployment and reverse-proxy control plane.
- The supported baseline production pattern is Cloudflare proxied DNS to the Coolify-managed origin, not direct origin exposure.
- Cloudflare Tunnel may be used later if operators choose it, but it is not the baseline deployment contract documented for this repository.
- `SITE_URL` must match the hostname users reach through Cloudflare, not an internal container or local Coolify address.
- Client IP extraction should trust `CF-Connecting-IP`, not raw `X-Forwarded-For`, for the supported Cloudflare path.
- Direct origin access should be restricted so routine public traffic cannot bypass Cloudflare.

See `docs/process/cloudflare-coolify-origin-hardening.md` for the supported ingress model and operator checks.

### PostgreSQL On VPS

- Production `DATABASE_URL` should point to the intended remote PostgreSQL instance.
- The database path should be treated as a remote secured dependency, not a localhost-only assumption.
- Prefer PostgreSQL TLS, restricted ingress, and strong authentication for the application user.
- Prefer `hostssl` plus `scram-sha-256` for remote app access where the PostgreSQL host is operator-managed.
- Restrict remote access to the specific app host or the narrowest private network range available.

See `docs/process/postgresql-vps-hardening.md` for the supported VPS transport and access posture.

## Deployment Baseline

For the intended production topology, configure at least:

- `DATABASE_URL`
- `SITE_URL`
- `MINI_TOTP_ENCRYPTION_KEY`
- `TRUSTED_PROXY_MODE=cloudflare`

Also set `APP_SECRET` if the host auth/session runtime depends on it or if you need the current Mini fallback path during migration, but do not treat that fallback as the preferred long-term TOTP configuration.

## Validation

- `pnpm typecheck`
- `pnpm build`
- local boot or build smoke test with the configured `DATABASE_URL`
