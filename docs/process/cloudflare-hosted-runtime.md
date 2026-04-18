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
- optional `ADMIN_SITE_URL` matches the dedicated Cloudflare admin hostname when split public/admin hostnames are used
- `TRUSTED_PROXY_MODE=cloudflare`
- `DATABASE_URL` points to the intended remote PostgreSQL instance
- `wrangler.jsonc` or equivalent deployment config defines the Worker, assets, observability, and required bindings
- `TURNSTILE_SECRET_KEY` is stored as a server-only secret when Turnstile protection is enabled
- `TURNSTILE_EXPECTED_HOSTNAMES` should be set or derived correctly when Turnstile is used across both the public and admin hostnames
- `EDGE_API_JWT_SECRET` is stored as a server-only secret when edge API token issuance is enabled
- `R2_MEDIA_BUCKET_BINDING=MEDIA_BUCKET` maps to the private R2 bucket `awcms-mini-s3` when object storage is enabled
- `EDGE_API_ALLOWED_ORIGINS` stays empty unless an approved cross-origin external client needs browser access

## Cloudflare Expectations

- Use the Astro Cloudflare adapter for the supported runtime build
- Keep Worker compatibility flags aligned with the runtime needs of the current codebase
- Keep observability enabled for production deployment
- Prefer Worker custom domains for `awcms-mini.ahlikoding.com` and `awcms-mini-admin.ahlikoding.com` because the Worker is the origin for this deployment model
- Ensure the adapter's default `SESSION` KV binding or an explicit equivalent binding is available
- If split hostnames are used, keep the admin hostname pointed at the same Worker deployment and treat it as an entry host for `/_emdash/admin`
- Add edge protections such as rate limiting, managed challenge, or Turnstile on abuse-prone routes as those features land
- The current Turnstile-covered public flows are login, password-reset request, and invite activation when the Turnstile secret is configured
- Keep Turnstile hostname expectations aligned with `SITE_URL`, `ADMIN_SITE_URL`, or an explicit `TURNSTILE_EXPECTED_HOSTNAMES` allowlist
- Keep `/api/v1/token` behind Cloudflare rate limiting or equivalent abuse controls before broad external-client rollout
- Keep R2 buckets private by default and expose downloads through controlled application paths as upload features land
- Keep the Worker R2 binding aligned with `awcms-mini-s3` unless an explicit reviewed bucket migration occurs
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
- Confirm `wrangler.jsonc` declares custom-domain routes for `awcms-mini.ahlikoding.com` and `awcms-mini-admin.ahlikoding.com`
- Confirm the `MEDIA_BUCKET` binding targets `awcms-mini-s3`
- Confirm `MINI_RUNTIME_TARGET=cloudflare` in the deployment environment
- Confirm `SITE_URL`, `TRUSTED_PROXY_MODE`, and security secrets are set correctly
- Confirm `ADMIN_SITE_URL` and any non-default `ADMIN_ENTRY_PATH` are set correctly when a separate admin hostname is used
- Confirm `TURNSTILE_EXPECTED_HOSTNAMES` or its derived fallback matches the reviewed public/admin hostname set when Turnstile is enabled
- Confirm `EDGE_API_JWT_SECRET` and any non-default `EDGE_API_JWT_*` settings are set correctly when `/api/v1/token` is enabled
- Confirm `DATABASE_URL` or approved database transport configuration points to the intended PostgreSQL target

After deployment:

- Confirm the public hostname responds through the Cloudflare-hosted runtime
- Confirm admin routes load through the public hostname or, when configured, the dedicated admin hostname
- Confirm auth logging and lockout behavior reflect the expected Cloudflare client IP source
- Confirm the runtime can see the `MEDIA_BUCKET` binding for `awcms-mini-s3`
- Confirm the app can reach PostgreSQL and complete health or smoke tests for the selected environment

## Cloudflare Automation Smoke Tests

Run these in order after a deployment or after Cloudflare-side automation changes.

### 1. Public Hostname

- Request `https://awcms-mini.ahlikoding.com/` and confirm the public site responds through the current Worker deployment.
- Confirm the response is served through Cloudflare-managed TLS.
- Confirm the public hostname remains the canonical browser-facing site URL.
- Confirm the hostname is attached through the Worker custom-domain path rather than an unrelated legacy route.

### 2. Admin Hostname

- Request `https://awcms-mini-admin.ahlikoding.com/`.
- Confirm the hostname root redirects to `/_emdash/admin` on the same host.
- Confirm the EmDash admin surface loads there without introducing a second admin shell or alternate API surface.
- Confirm the hostname is attached through the same Worker deployment as the public hostname.

### 3. Turnstile-Protected Flows

- Confirm the login screen renders the Turnstile widget when Turnstile is enabled.
- Confirm a valid Turnstile solve allows the protected flow to continue.
- Confirm an invalid or missing token fails server-side.
- Confirm Siteverify hostname handling accepts only the reviewed hostname set from `TURNSTILE_EXPECTED_HOSTNAMES` or the derived `SITE_URL` and `ADMIN_SITE_URL` fallback.
- Review Turnstile analytics for unexpected hostname, action, or challenge anomalies after rollout.

### 4. R2 Binding

- Confirm `wrangler.jsonc` and the deployed Worker configuration still bind `MEDIA_BUCKET` to `awcms-mini-s3`.
- Confirm the runtime can resolve the `MEDIA_BUCKET` binding without throwing `R2_BUCKET_NOT_CONFIGURED`.
- If an upload-capable flow is enabled in the environment, confirm the app can write and read an approved private object through the application path.

### 5. PostgreSQL Reachability

- Run `pnpm healthcheck` or the environment-equivalent health path.
- Confirm the app can still reach PostgreSQL on the Coolify-managed VPS.
- Confirm no Cloudflare-side automation change accidentally altered the database path assumptions.

## Partial Provisioning Rollback

If Cloudflare automation only partially succeeds, use the smallest rollback that restores a coherent deployment state.

Rollback order:

1. Record the currently deployed git commit and the active Worker version.
2. Record which Cloudflare-side resources changed: hostname routing, Turnstile widget settings, Worker bindings, or R2 bucket configuration.
3. If the Worker code deployment is the problem, roll back the Worker with `wrangler rollback` to the last known good version.
4. If a hostname mapping is wrong, remove or correct the custom-domain or route change before changing app code.
5. If Turnstile blocks valid traffic, restore the previous reviewed hostname set or secret configuration rather than disabling all server-side validation blindly.
6. If the `MEDIA_BUCKET` binding is missing or incorrect, restore the last known good Worker binding configuration before changing application storage logic.
7. Re-run the smoke tests in this document after the rollback step completes.

Do not mix partial Cloudflare rollback, unreviewed runtime edits, and direct database changes in the same recovery step unless the incident has been escalated and the operator has captured the full state first.

## Current Account Visibility Caveat

During the current implementation pass, the Cloudflare MCP session did not return visible zone, Worker, or custom-domain inventory for account `5255727b7269584897c8c97ebdd3347f`.

Current consequence:

- the repository now declares the intended custom-domain automation baseline in `wrangler.jsonc`
- operators should still record the live `ahlikoding.com` zone ID and confirm the deployed Worker is the target of both custom domains during environment rollout
- the smoke tests in this document remain the required verification step until account inventory is readable through the available Cloudflare management path

## Cross-References

- `docs/architecture/runtime-config.md`
- `docs/security/operations.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/postgresql-vps-hardening.md`
