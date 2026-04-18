# Runtime Configuration

## Purpose

This document defines the base runtime configuration contract for the AWCMS Mini scaffold.

## Current Runtime Settings

### `MINI_RUNTIME_TARGET`

- Purpose: select the Astro adapter/runtime target for the build.
- Supported values: `cloudflare`, `node`.
- Default fallback: `cloudflare`.
- Current rule: the supported production baseline is Cloudflare-hosted runtime. `node` remains an explicit fallback target during migration and local compatibility work.

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

### `TURNSTILE_SITE_KEY`

- Purpose: public Cloudflare Turnstile site key for clients rendering the widget.
- Scope: deployment/runtime configuration.
- Rule: pair this with `TURNSTILE_SECRET_KEY` for protected public flows.

### `TURNSTILE_SECRET_KEY`

- Purpose: server-side secret used for mandatory Turnstile Siteverify validation.
- Scope: server-only runtime secret.
- Current rule: Turnstile enforcement activates when this value is configured.

### `TURNSTILE_EXPECTED_HOSTNAME`

- Purpose: optional explicit hostname check for Turnstile Siteverify results.
- Scope: server-only runtime configuration.
- Default behavior: falls back to the hostname parsed from `SITE_URL` when omitted.

### `R2_MEDIA_BUCKET_BINDING`

- Purpose: Cloudflare Worker binding name used for private R2-backed object storage.
- Scope: server-only runtime configuration.
- Default fallback: `MEDIA_BUCKET`.

### `R2_MEDIA_BUCKET_NAME`

- Purpose: optional operator-facing bucket name reference for deployment documentation and binding alignment.
- Scope: runtime/deployment documentation value.

### `R2_MAX_UPLOAD_BYTES`

- Purpose: maximum accepted object size for the current R2 upload policy.
- Scope: server-only runtime configuration.
- Default fallback: `5242880` (5 MiB).

### `R2_ALLOWED_CONTENT_TYPES`

- Purpose: allowlist of MIME types accepted by the current R2 upload policy.
- Scope: server-only runtime configuration.
- Default fallback: `image/jpeg,image/png,image/webp,application/pdf`.

### `EDGE_API_ALLOWED_ORIGINS`

- Purpose: explicit allowlist for cross-origin browser clients calling the versioned edge API.
- Scope: server-only runtime configuration.
- Default behavior: no cross-origin browser origins are allowed unless explicitly configured.

### `EDGE_API_MAX_BODY_BYTES`

- Purpose: maximum accepted request body size for the versioned edge API baseline.
- Scope: server-only runtime configuration.
- Default fallback: `16384` bytes.

## Source of Truth

- runtime config module: `src/config/runtime.mjs`
- Astro integration wiring: `astro.config.mjs`
- local environment example: `.env.example`
- Cloudflare deployment configuration: `wrangler.jsonc`
- TOTP encryption key resolution: `src/services/security/two-factor.mjs`
- Turnstile validation helper: `src/security/turnstile.mjs`
- R2 storage helper: `src/services/storage/r2.mjs`
- Edge API helpers: `src/api/edge/v1.mjs`, `src/api/edge/session.mjs`, `src/api/edge/health.mjs`

## Rules

- keep runtime connection settings isolated in `src/config/`
- do not inline database connection strings across multiple files
- do not introduce Supabase-specific environment variables
- treat `DATABASE_URL` as the canonical PostgreSQL runtime input
- document security-sensitive secrets explicitly when code depends on them
- prefer a dedicated `MINI_TOTP_ENCRYPTION_KEY` over the `APP_SECRET` fallback for TOTP secret encryption
- document public-origin and trusted-proxy assumptions explicitly for Cloudflare-fronted deployments
- for remote PostgreSQL deployments, prefer TLS-enabled connections and host-level access restriction
- store Turnstile secrets in Cloudflare-managed secrets or equivalent server-only runtime configuration
- keep R2 buckets private by default and access them through Cloudflare bindings, not REST calls from runtime code
- keep object metadata, ownership, and authorization state in PostgreSQL even when object bytes live in R2
- keep edge API routes versioned under `/api/v1/*` and separate from EmDash admin/plugin APIs under `/_emdash/api/*`
- disable cross-origin browser access unless an explicit origin allowlist is configured

## Deployment Notes

### Cloudflare Plus Coolify

- Cloudflare should be treated as both the browser-facing edge and the supported application hosting baseline.
- Coolify should be treated as the operational control plane for the PostgreSQL VPS, not as the primary app hosting path.
- `MINI_RUNTIME_TARGET=cloudflare` is the supported production setting.
- `SITE_URL` must match the hostname users reach through Cloudflare.
- Client IP extraction should trust `CF-Connecting-IP`, not raw `X-Forwarded-For`, for the supported Cloudflare-hosted path.
- `wrangler.jsonc` should define the Worker, static assets, observability, and any explicit Cloudflare bindings needed for deployment.
- Astro's Cloudflare adapter uses the default `SESSION` KV binding for sessions unless operators override it deliberately.
- Cloudflare Hyperdrive is the recommended next-step pooling path for PostgreSQL access from edge-hosted runtime code, but the current repo still uses `DATABASE_URL` directly.
- R2-backed object storage should use a private bucket binding and application-generated object keys.

See `docs/process/cloudflare-hosted-runtime.md` for the supported hosting model and deployment checks.

### PostgreSQL On VPS

- Production `DATABASE_URL` should point to the intended remote PostgreSQL instance.
- The database path should be treated as a remote secured dependency, not a localhost-only assumption.
- Prefer PostgreSQL TLS, restricted ingress, and strong authentication for the application user.
- Prefer `hostssl` plus `scram-sha-256` for remote app access where the PostgreSQL host is operator-managed.
- Restrict remote access to the specific app host or the narrowest private network range available.
- If the Cloudflare-hosted runtime later adopts Hyperdrive, treat that as a transport and pooling layer over the same PostgreSQL security posture rather than a replacement for PostgreSQL controls.

See `docs/process/postgresql-vps-hardening.md` for the supported VPS transport and access posture.

## Deployment Baseline

For the intended production topology, configure at least:

- `DATABASE_URL`
- `MINI_RUNTIME_TARGET=cloudflare`
- `SITE_URL`
- `MINI_TOTP_ENCRYPTION_KEY`
- `TRUSTED_PROXY_MODE=cloudflare`

For public auth and recovery abuse defense, also configure:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- optional `TURNSTILE_EXPECTED_HOSTNAME`

For private R2-backed object storage, also configure:

- `R2_MEDIA_BUCKET_BINDING`
- optional `R2_MEDIA_BUCKET_NAME`
- `R2_MAX_UPLOAD_BYTES`
- `R2_ALLOWED_CONTENT_TYPES`

For the versioned edge API baseline, also configure as needed:

- optional `EDGE_API_ALLOWED_ORIGINS`
- `EDGE_API_MAX_BODY_BYTES`

Also set `APP_SECRET` if the host auth/session runtime depends on it or if you need the current Mini fallback path during migration, but do not treat that fallback as the preferred long-term TOTP configuration.

## Validation

- `pnpm typecheck`
- `pnpm build`
- local boot or build smoke test with the configured `DATABASE_URL`
