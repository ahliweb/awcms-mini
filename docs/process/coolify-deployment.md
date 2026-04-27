# Coolify Deployment Guide

## Purpose

This document defines the current reviewed deployment path for AWCMS Mini.

The active target topology is:

1. Cloudflare Pages serves the public frontend
2. the frontend calls the Hono backend through `PUBLIC_API_BASE_URL`
3. Hono runs on a Coolify-managed VPS
4. PostgreSQL runs as a private Docker service on the same Coolify-managed VPS
5. Cloudflare R2 stores object bytes when object storage is enabled

This is the maintained deployment baseline for the current repository state.

## Topology

```text
Cloudflare Pages (frontend)
        |
        v (HTTPS API calls via PUBLIC_API_BASE_URL)
Hono Backend API - Coolify-managed VPS
        |
        +--> PostgreSQL Docker service (internal Docker network)
        |
        +--> Cloudflare R2 (object storage)
        |
        +--> Mailketing Email API
        |
        +--> Starsender WhatsApp API
```

## Required Boundaries

- PostgreSQL is not exposed to the public internet.
- The Hono backend is the only approved PostgreSQL access layer.
- Cloudflare Pages must not connect to PostgreSQL directly.
- Secrets stay in Coolify locked runtime secrets, Cloudflare-managed secrets, or local-only operator files such as `.env.local`.
- The current architecture does not use Cloudflare Hyperdrive. See `docs/process/no-hyperdrive-adr.md`.

## Service Layout In Coolify

### `awcms-mini-api`

- Runtime: Node.js application for the Hono backend
- Entry path: `server/index.mjs`
- Expected production runtime target: `MINI_RUNTIME_TARGET=node`
- Health endpoint: `GET /health`
- Trust boundary: only the backend service may read runtime secrets such as `DATABASE_URL`, `APP_SECRET`, `MINI_TOTP_ENCRYPTION_KEY`, `EDGE_API_JWT_SECRET`, `TURNSTILE_SECRET_KEY`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`

### `awcms-mini-postgres`

- Runtime: PostgreSQL Docker service
- Network posture: private Docker-network access from the Hono backend
- Reviewed internal hostname: `postgres`
- External/public exposure: disabled

## Required Environment Variables

### Backend Runtime

- `DATABASE_URL`
- `DATABASE_TRANSPORT=direct`
- optional `DATABASE_CONNECT_TIMEOUT_MS`
- `MINI_RUNTIME_TARGET=node`
- `SITE_URL`
- optional `ADMIN_SITE_URL`
- optional `ADMIN_ENTRY_PATH`
- `TRUSTED_PROXY_MODE=cloudflare`
- `APP_SECRET`
- `MINI_TOTP_ENCRYPTION_KEY`
- `EDGE_API_JWT_SECRET`
- `EDGE_API_ACCESS_TOKEN_TTL_SECONDS`
- `EDGE_API_REFRESH_TOKEN_TTL_SECONDS`
- `EDGE_API_MAX_BODY_BYTES`
- optional `EDGE_API_ALLOWED_ORIGINS`

### Public Abuse Defense

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- optional `TURNSTILE_EXPECTED_HOSTNAME`
- optional `TURNSTILE_EXPECTED_HOSTNAMES`

### R2 Object Storage

- `R2_MEDIA_BUCKET_NAME`
- `R2_MEDIA_BUCKET_BINDING`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_MAX_UPLOAD_BYTES`
- `R2_ALLOWED_CONTENT_TYPES`

### Frontend Runtime

- `PUBLIC_API_BASE_URL`

Use `.env.example` as the documented variable-name reference only. Do not copy real credentials into tracked files.

## Deployment Sequence

1. Configure the PostgreSQL Docker service in Coolify.
2. Keep the PostgreSQL service private on the Coolify Docker network.
3. Configure the Hono backend service with the required runtime secrets.
4. Point `DATABASE_URL` at the private PostgreSQL hostname, for example `postgresql://app_user:<password>@postgres:5432/awcms_mini`.
5. Configure the public domain and HTTPS for the backend if frontend-to-backend calls use a public API hostname.
6. Configure Cloudflare Pages with `PUBLIC_API_BASE_URL` pointing at the reviewed Hono API origin.
7. Run migrations before or during the release window with the reviewed migration sequence.
8. Run health and smoke checks after deploy.

## Secrets And Operator Storage

- Store backend runtime secrets in Coolify locked runtime secrets where supported.
- Keep build-time sensitive inputs in Coolify Docker Build Secrets only when a reviewed build workflow actually needs them.
- Keep `CLOUDFLARE_API_TOKEN` and Coolify management tokens in local-only operator storage or approved CI/CD secret storage.
- Do not place database passwords, API keys, or token values in docs, issue comments, or tracked shell snippets.

## PostgreSQL Posture

- Use a non-superuser application role for `DATABASE_URL`.
- Keep PostgreSQL ingress limited to the application host or private network path.
- Prefer TLS-enabled PostgreSQL connections when the deployment path is remote rather than same-host private Docker networking.
- Treat `docs/process/postgresql-vps-hardening.md` as the operator hardening companion for the database host.

## Health And Validation

Before release:

- `pnpm lint`
- `pnpm check`

During or after release:

- `pnpm db:migrate`
- `pnpm db:migrate:status`
- `pnpm healthcheck`

For deployment-window validation, also use:

- `docs/process/migration-deployment-checklist.md`
- `docs/process/runtime-smoke-test.md`

## Historical And Alternative Docs

- `docs/process/cloudflare-hosted-runtime.md` is historical reference for the earlier Cloudflare-hosted runtime path.
- `docs/process/cloudflare-coolify-origin-hardening.md` is a historical or alternative ingress-hardening reference, not the current primary deployment guide.
- `docs/process/cloudflare-pages-vs-workers-decision.md` records the earlier decision context that favored a single Worker runtime over a Pages split at that time.

## Cross-References

- `docs/architecture/overview.md`
- `docs/architecture/runtime-config.md`
- `docs/process/no-hyperdrive-adr.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/security/operations.md`
