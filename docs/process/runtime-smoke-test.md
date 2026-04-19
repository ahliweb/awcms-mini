# Runtime Smoke Test

## Purpose

This document defines the baseline smoke-test path for the current scaffold.

## Validation Path

Use the CLI runtime validation path:

```bash
pnpm healthcheck
```

The command reports:

- runtime validation execution
- database connectivity
- timestamped status output

## Manual Smoke Test

1. Start a PostgreSQL database reachable by `DATABASE_URL`.
2. For the reviewed remote production posture, use `id1.ahlikoding.com` with `sslmode=verify-full` when certificate validation is available.
3. Set `SITE_URL` to the browser-facing hostname for the environment when validating a deployed-style build.
4. If split hostnames are enabled, set `ADMIN_SITE_URL` to the dedicated admin hostname.
5. Set `TRUSTED_PROXY_MODE` for the expected request path.
6. Build the app with `pnpm build`.
7. Run `pnpm healthcheck`.
8. Confirm:
   - `ok` is `true`
   - `checks.app.ok` is `true`
   - `checks.database.ok` is `true`
   - the reviewed PostgreSQL SSL hostname and mode match the target environment posture

## Cloudflare Automation Smoke Test

Use these checks after Cloudflare hostname, Turnstile, or R2 automation changes.

1. Load the public hostname and confirm it responds through the active Worker deployment.
2. Load `https://awcms-mini.ahlikoding.com/_emdash/` and confirm it redirects to `/_emdash/admin` on the same host.
3. If `ADMIN_SITE_URL` is still enabled for compatibility, load the admin hostname root and confirm it redirects to the configured admin entry path.
4. Exercise at least one Turnstile-protected public flow and confirm:
   - a valid solve succeeds
   - an invalid or missing token fails server-side
   - hostname validation matches the reviewed hostname set for the environment
5. Confirm the deployed runtime still has the `MEDIA_BUCKET` binding for `awcms-mini-s3`.
6. Re-run `pnpm healthcheck` or the target-environment equivalent after Cloudflare-side changes complete.

## Failure Modes

- if the runtime build is broken, `pnpm build` fails
- if the database is unreachable, `pnpm healthcheck` exits non-zero
- database failures return a classified `kind` to make startup issues easier to identify
- if hostname automation is only partially applied, the public or admin hostname smoke tests fail
- if Turnstile hostname configuration is wrong, valid solves fail server-side with hostname mismatch behavior
- if the Worker R2 binding is missing, runtime storage paths fail with `R2_BUCKET_NOT_CONFIGURED`

## Validation

- `pnpm typecheck`
- `pnpm build`
- `pnpm healthcheck`
