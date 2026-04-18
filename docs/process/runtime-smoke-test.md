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
2. Set `SITE_URL` to the browser-facing hostname for the environment when validating a deployed-style build.
3. If split hostnames are enabled, set `ADMIN_SITE_URL` to the dedicated admin hostname.
4. Set `TRUSTED_PROXY_MODE` for the expected request path.
5. Build the app with `pnpm build`.
6. Run `pnpm healthcheck`.
7. Confirm:
   - `ok` is `true`
   - `checks.app.ok` is `true`
   - `checks.database.ok` is `true`

## Cloudflare Automation Smoke Test

Use these checks after Cloudflare hostname, Turnstile, or R2 automation changes.

1. Load the public hostname and confirm it responds through the active Worker deployment.
2. If `ADMIN_SITE_URL` is enabled, load the admin hostname root and confirm it redirects to `/_emdash/admin`.
3. Exercise at least one Turnstile-protected public flow and confirm:
   - a valid solve succeeds
   - an invalid or missing token fails server-side
   - hostname validation matches the reviewed public/admin hostname set
4. Confirm the deployed runtime still has the `MEDIA_BUCKET` binding for `awcms-mini-s3`.
5. Re-run `pnpm healthcheck` or the target-environment equivalent after Cloudflare-side changes complete.

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
