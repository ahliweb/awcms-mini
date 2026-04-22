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
- Production guidance: point this to the remote PostgreSQL host for the environment and encode the reviewed TLS posture directly in the connection string.
- Reviewed production example: `postgres://awcms_mini_app:<password>@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full`
- Operator inventory note: `202.10.45.224` remains the reviewed VPS IP for troubleshooting and server-side config, but the application should prefer `id1.ahlikoding.com` when hostname validation is expected to succeed.
- Interim guidance: if certificate hostname validation is not ready yet, use an explicitly reviewed TLS-required mode such as `sslmode=require` and track the follow-on hardening work.
- Role guidance: do not use PostgreSQL superuser credentials for the normal app runtime.

### `DATABASE_TRANSPORT`

- Purpose: selects whether the runtime should use direct `DATABASE_URL` transport or a Cloudflare Hyperdrive binding.
- Supported values: `direct`, `hyperdrive`.
- Default fallback: `direct`.
- Production guidance: the current reviewed Cloudflare Worker baseline uses `hyperdrive` with the `HYPERDRIVE` binding. Keep `direct` as an explicit local, rollback, or issue-scoped remediation path when operators intentionally select it.

### `DATABASE_CONNECT_TIMEOUT_MS`

- Purpose: maximum time in milliseconds the Node/PostgreSQL client should wait for a new connection before failing.
- Scope: server-only runtime configuration.
- Default fallback: `10000`.
- Production guidance: keep this explicit for operator commands, smoke tests, and migration tooling so unreachable Cloudflare-to-Coolify or local-to-VPS database paths fail fast instead of hanging indefinitely.

### `HYPERDRIVE_BINDING`

- Purpose: names the Cloudflare Hyperdrive binding used when `DATABASE_TRANSPORT=hyperdrive`.
- Default fallback: `HYPERDRIVE`.
- Rule: this is a binding name, not a secret or connection string.

### `HEALTHCHECK_EXPECT_DATABASE_TRANSPORT`

- Purpose: optional non-secret expectation used by `pnpm healthcheck` to fail fast when the runtime uses the wrong reviewed database transport.
- Supported values: `direct`, `hyperdrive`.
- Scope: rollout verification input, not a runtime secret.
- Default behavior: unset, so the healthcheck reports posture without asserting it.

### `HEALTHCHECK_EXPECT_DATABASE_HOSTNAME`

- Purpose: optional non-secret expectation used by `pnpm healthcheck` when direct transport should point at a reviewed hostname.
- Scope: rollout verification input, not a runtime secret.
- Example: `id1.ahlikoding.com`.

### `HEALTHCHECK_EXPECT_DATABASE_SSLMODE`

- Purpose: optional non-secret expectation used by `pnpm healthcheck` when direct transport should enforce a reviewed PostgreSQL SSL mode.
- Scope: rollout verification input, not a runtime secret.
- Example: `verify-full`.

### `HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING`

- Purpose: optional non-secret expectation used by `pnpm healthcheck` when Hyperdrive rollout should resolve through the reviewed binding name.
- Scope: rollout verification input, not a runtime secret.
- Default reviewed binding name: `HYPERDRIVE`.

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

### `ADMIN_SITE_URL`

- Purpose: optional dedicated admin hostname that still resolves to the same EmDash admin surface.
- Scope: server/runtime configuration.
- Format: absolute URL such as `https://cms-admin.example.com`.
- Current behavior: when `SITE_URL` and `ADMIN_SITE_URL` are both configured, requests to the admin hostname root redirect to the configured admin entry path instead of introducing a second admin shell.

### `ADMIN_ENTRY_PATH`

- Purpose: pathname used as the admin-host entry redirect target.
- Scope: server/runtime configuration.
- Default fallback: `/_emdash/`.
- Rule: this should remain an EmDash admin path, not a second standalone admin application.

### `TRUSTED_PROXY_MODE`

- Purpose: define which proxy path is trusted for client IP extraction.
- Supported values: `direct`, `cloudflare`, `forwarded-chain`.
- Default fallback: `direct`.
- Rule: Cloudflare plus Coolify deployments should set `TRUSTED_PROXY_MODE=cloudflare` so auth, audit, and lockout flows use `CF-Connecting-IP`.

### `TURNSTILE_SITE_KEY`

- Purpose: public Cloudflare Turnstile site key for clients rendering the widget.
- Scope: deployment/runtime configuration.
- Rule: pair this with `TURNSTILE_SECRET_KEY` for protected public flows such as login, password-reset request, and invite activation.

### `TURNSTILE_SECRET_KEY`

- Purpose: server-side secret used for mandatory Turnstile Siteverify validation.
- Scope: server-only runtime secret.
- Current rule: Turnstile enforcement activates when this value is configured.

### `TURNSTILE_EXPECTED_HOSTNAME`

- Purpose: optional explicit hostname check for Turnstile Siteverify results.
- Scope: server-only runtime configuration.
- Default behavior: legacy single-host override only. Prefer `TURNSTILE_EXPECTED_HOSTNAMES` for new split-hostname deployments.

### `TURNSTILE_EXPECTED_HOSTNAMES`

- Purpose: explicit allowlist of accepted hostnames for Turnstile Siteverify results.
- Scope: server-only runtime configuration.
- Format: comma-separated hostnames.
- Default behavior: falls back to hostnames derived from `SITE_URL` and `ADMIN_SITE_URL` when omitted.

### `R2_MEDIA_BUCKET_BINDING`

- Purpose: Cloudflare Worker binding name used for private R2-backed object storage.
- Scope: server-only runtime configuration.
- Default fallback: `MEDIA_BUCKET`.
- Current deployment target: `MEDIA_BUCKET` should map to the Cloudflare R2 bucket `awcms-mini-s3`.

### `R2_MEDIA_BUCKET_NAME`

- Purpose: operator-facing bucket name reference for deployment documentation and binding alignment.
- Scope: runtime/deployment documentation value.
- Current deployment target: `awcms-mini-s3`.

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

### `EDGE_API_JWT_SECRET`

- Purpose: signing and verification secret for JWT access tokens issued by `/api/v1/token`.
- Scope: server-only runtime secret.
- Default behavior: falls back to `APP_SECRET` when omitted.
- Rule: production deployments should set a dedicated value instead of relying on the fallback.

### `EDGE_API_JWT_ISSUER`

- Purpose: expected JWT issuer for edge API Bearer tokens.
- Scope: server-only runtime configuration.
- Default behavior: falls back to `SITE_URL + /api/v1` when `SITE_URL` is configured, otherwise `urn:awcms-mini:edge-api`.

### `EDGE_API_JWT_AUDIENCE`

- Purpose: expected JWT audience for edge API Bearer tokens.
- Scope: server-only runtime configuration.
- Default fallback: `awcms-mini-edge-api`.

### `EDGE_API_ACCESS_TOKEN_TTL_SECONDS`

- Purpose: TTL for JWT access tokens issued by `/api/v1/token`.
- Scope: server-only runtime configuration.
- Default fallback: `900` seconds.

### `EDGE_API_REFRESH_TOKEN_TTL_SECONDS`

- Purpose: TTL for opaque refresh tokens issued by `/api/v1/token`.
- Scope: server-only runtime configuration.
- Default fallback: `2592000` seconds.

## Source of Truth

- runtime config module: `src/config/runtime.mjs`
- Astro integration wiring: `astro.config.mjs`
- local environment example: `.env.example`
- Cloudflare deployment configuration: `wrangler.jsonc`
- host-aware admin entry middleware: `src/auth/middleware-entry.mjs`
- TOTP encryption key resolution: `src/services/security/two-factor.mjs`
- Turnstile validation helper: `src/security/turnstile.mjs`
- R2 storage helper: `src/services/storage/r2.mjs`
- Edge API helpers: `src/api/edge/v1.mjs`, `src/api/edge/session.mjs`, `src/api/edge/health.mjs`
- Edge API token route: `src/api/edge/token.mjs`, `src/pages/api/v1/token.js`
- Edge auth service: `src/services/edge-auth/service.mjs`

## Rules

- keep runtime connection settings isolated in `src/config/`
- do not inline database connection strings across multiple files
- do not introduce Supabase-specific environment variables
- treat `DATABASE_URL` as the canonical PostgreSQL runtime input
- keep `HEALTHCHECK_EXPECT_*` values optional and use them only for non-secret rollout verification
- document security-sensitive secrets explicitly when code depends on them
- prefer a dedicated `MINI_TOTP_ENCRYPTION_KEY` over the `APP_SECRET` fallback for TOTP secret encryption
- document public-origin and trusted-proxy assumptions explicitly for Cloudflare-fronted deployments
- if `ADMIN_SITE_URL` is configured, treat it as an entry hostname for the same EmDash admin surface rather than a second admin runtime
- for remote PostgreSQL deployments, prefer TLS-enabled connections and host-level access restriction
- store Turnstile secrets in Cloudflare-managed secrets or equivalent server-only runtime configuration
- for split public/admin hostnames, validate Turnstile Siteverify results against an explicit hostname allowlist rather than a single hostname only
- store `EDGE_API_JWT_SECRET` in Cloudflare-managed secrets or equivalent server-only runtime configuration
- keep R2 buckets private by default and access them through Cloudflare bindings, not REST calls from runtime code
- keep object metadata, ownership, and authorization state in PostgreSQL even when object bytes live in R2
- keep edge API routes versioned under `/api/v1/*` and separate from EmDash admin/plugin APIs under `/_emdash/api/*`
- disable cross-origin browser access unless an explicit origin allowlist is configured
- keep edge API refresh tokens opaque, hashed at rest, and rotation-backed in PostgreSQL

## Deployment Notes

### Cloudflare Plus Coolify

- Cloudflare should be treated as both the browser-facing edge and the supported application hosting baseline.
- Coolify should be treated as the operational control plane for the PostgreSQL VPS, not as the primary app hosting path.
- `MINI_RUNTIME_TARGET=cloudflare` is the supported production setting.
- `SITE_URL` must match the hostname users reach through Cloudflare.
- `ADMIN_SITE_URL`, when configured, should be the Cloudflare-managed admin hostname that redirects into the same `/_emdash/admin` surface.
- Client IP extraction should trust `CF-Connecting-IP`, not raw `X-Forwarded-For`, for the supported Cloudflare-hosted path.
- `wrangler.jsonc` should define the Worker, static assets, observability, and any explicit Cloudflare bindings needed for deployment.
- `wrangler.jsonc` now declares the `MEDIA_BUCKET` R2 binding for `awcms-mini-s3` as the current deployment target.
- Astro's Cloudflare adapter uses the default `SESSION` KV binding for sessions unless operators override it deliberately.
- Cloudflare Hyperdrive is the current reviewed PostgreSQL transport for the Cloudflare-hosted Worker baseline. The repository still supports direct `DATABASE_URL` transport for local execution, rollback, and issue-scoped remediation work.
- R2-backed object storage should use a private bucket binding and application-generated object keys.

See `docs/process/cloudflare-hosted-runtime.md` for the supported hosting model and deployment checks.

### PostgreSQL On VPS

- Production `DATABASE_URL` should point to the intended remote PostgreSQL instance.
- The database path should be treated as a remote secured dependency, not a localhost-only assumption.
- Prefer PostgreSQL TLS, restricted ingress, and strong authentication for the application user.
- Prefer `hostssl` plus `scram-sha-256` for remote app access where the PostgreSQL host is operator-managed.
- Restrict remote access to the specific app host or the narrowest private network range available.
- If the Cloudflare-hosted runtime later adopts Hyperdrive, treat that as a transport and pooling layer over the same PostgreSQL security posture rather than a replacement for PostgreSQL controls.

See `docs/process/cloudflare-hyperdrive-decision.md` for the current decision and follow-on expectations.

See `docs/process/postgresql-vps-hardening.md` for the supported VPS transport and access posture.

## Deployment Baseline

For the intended production topology, configure at least:

- `DATABASE_URL`
- `DATABASE_TRANSPORT=hyperdrive` for the reviewed Cloudflare-hosted Worker baseline
- `DATABASE_TRANSPORT=direct` only when local execution, rollback, or issue-scoped remediation intentionally needs the direct PostgreSQL path
- optional `HYPERDRIVE_BINDING`
- optional `DATABASE_CONNECT_TIMEOUT_MS`
- `MINI_RUNTIME_TARGET=cloudflare`
- `SITE_URL`
- optional `ADMIN_SITE_URL`
- optional `ADMIN_ENTRY_PATH`
- `MINI_TOTP_ENCRYPTION_KEY`
- `TRUSTED_PROXY_MODE=cloudflare`

For optional rollout verification with `pnpm healthcheck`, also configure as needed:

- optional `HEALTHCHECK_EXPECT_DATABASE_TRANSPORT`
- optional `HEALTHCHECK_EXPECT_DATABASE_HOSTNAME`
- optional `HEALTHCHECK_EXPECT_DATABASE_SSLMODE`
- optional `HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING`

For public auth and recovery abuse defense, also configure:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- optional `TURNSTILE_EXPECTED_HOSTNAME`
- optional `TURNSTILE_EXPECTED_HOSTNAMES`

For private R2-backed object storage, also configure:

- `R2_MEDIA_BUCKET_BINDING`
- `R2_MEDIA_BUCKET_NAME`
- `R2_MAX_UPLOAD_BYTES`
- `R2_ALLOWED_CONTENT_TYPES`

For the versioned edge API baseline, also configure as needed:

- optional `EDGE_API_ALLOWED_ORIGINS`
- `EDGE_API_MAX_BODY_BYTES`
- `EDGE_API_JWT_SECRET`
- optional `EDGE_API_JWT_ISSUER`
- optional `EDGE_API_JWT_AUDIENCE`
- `EDGE_API_ACCESS_TOKEN_TTL_SECONDS`
- `EDGE_API_REFRESH_TOKEN_TTL_SECONDS`

Also set `APP_SECRET` if the host auth/session runtime depends on it or if you need the current Mini fallback path during migration, but do not treat that fallback as the preferred long-term TOTP configuration.

## Validation

- `pnpm typecheck`
- `pnpm build`
- local boot or build smoke test with the configured `DATABASE_URL`
