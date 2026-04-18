# Cloudflare Hosted Runtime

## Purpose

This runbook defines the supported hosting baseline for AWCMS Mini when the application runtime is hosted on Cloudflare and PostgreSQL remains on a protected VPS managed through Coolify.

## Supported Baseline

The supported baseline production path is:

1. Browser to Cloudflare
2. Cloudflare-hosted AWCMS Mini runtime serves the public hostname
3. Mini connects to PostgreSQL on the protected VPS
4. Coolify manages the PostgreSQL host lifecycle and related operator configuration

## Runtime Expectations

- `MINI_RUNTIME_TARGET=cloudflare`
- `SITE_URL` matches the browser-facing Cloudflare hostname
- `TRUSTED_PROXY_MODE=cloudflare`
- `DATABASE_URL` points to the intended remote PostgreSQL instance
- `wrangler.jsonc` or equivalent deployment config defines the Worker, assets, observability, and required bindings
- `TURNSTILE_SECRET_KEY` is stored as a server-only secret when Turnstile protection is enabled
- `R2_MEDIA_BUCKET_BINDING` maps to a private R2 bucket when object storage is enabled
- `EDGE_API_ALLOWED_ORIGINS` stays empty unless an approved cross-origin external client needs browser access

## Cloudflare Expectations

- Use the Astro Cloudflare adapter for the supported runtime build
- Keep Worker compatibility flags aligned with the runtime needs of the current codebase
- Keep observability enabled for production deployment
- Ensure the adapter's default `SESSION` KV binding or an explicit equivalent binding is available
- Add edge protections such as rate limiting, managed challenge, or Turnstile on abuse-prone routes as those features land
- Keep Turnstile hostname expectations aligned with `SITE_URL` or an explicit `TURNSTILE_EXPECTED_HOSTNAME`
- Keep R2 buckets private by default and expose downloads through controlled application paths as upload features land
- Keep versioned external-client APIs under `/api/v1/*` and do not expose `/_emdash/api/*` as the mobile/external API surface

## PostgreSQL Expectations

- Treat PostgreSQL as a private remote dependency
- Use TLS for database traffic
- Keep firewall and `pg_hba.conf` rules scoped narrowly
- Use non-superuser runtime credentials
- If Hyperdrive is adopted later, treat it as the preferred pooling and transport layer from the Cloudflare-hosted runtime rather than a replacement for PostgreSQL hardening

## Minimum Operator Checks

Before deployment:

- Confirm `pnpm build` produces the Cloudflare Worker bundle successfully
- Confirm `wrangler.jsonc` matches the intended Worker name and bindings
- Confirm `MINI_RUNTIME_TARGET=cloudflare` in the deployment environment
- Confirm `SITE_URL`, `TRUSTED_PROXY_MODE`, and security secrets are set correctly
- Confirm `DATABASE_URL` or approved database transport configuration points to the intended PostgreSQL target

After deployment:

- Confirm the public hostname responds through the Cloudflare-hosted runtime
- Confirm admin routes load through the public hostname
- Confirm auth logging and lockout behavior reflect the expected Cloudflare client IP source
- Confirm the app can reach PostgreSQL and complete health or smoke tests for the selected environment

## Cross-References

- `docs/architecture/runtime-config.md`
- `docs/security/operations.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/postgresql-vps-hardening.md`
