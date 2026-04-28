# Cloudflare And Coolify Origin Hardening

## Status

Historical or alternative reference only.

## Purpose

This runbook preserves earlier Cloudflare-plus-Coolify ingress hardening notes.

The current maintained deployment baseline is `docs/process/coolify-deployment.md`.

## Current Supported Production Pattern

The supported baseline production path is now documented in `docs/process/coolify-deployment.md`.

This file remains only as a historical or alternative reference for earlier Cloudflare-to-origin hardening discussions.

## Historical Coolify-Hosted Application Path

A previous deployment pattern ran the Mini app as a Coolify-managed container behind a Coolify reverse proxy, with Cloudflare providing edge proxying to the Coolify origin. That path is no longer the reviewed runtime baseline. If an operator ever needs to restore or evaluate it, all trust-boundary and origin-exposure rules below remain applicable and a new reviewed issue should be opened rather than reverting runtime assumptions ad hoc.

## Trust Boundary Rules

- Cloudflare is the browser-facing edge for public and admin traffic.
- The maintained backend runtime is Hono on Coolify.
- PostgreSQL on the Coolify-managed VPS is a private database dependency, not a public service.
- The backend must use `TRUSTED_PROXY_MODE=cloudflare` to trust `CF-Connecting-IP` for client IP extraction.
- The backend must not trust raw `X-Forwarded-For` values from arbitrary upstream sources.
- The public origin must be the Cloudflare-served hostname, not a VPS IP, container address, or direct Coolify URL.

## Required Runtime Expectations

- Set the public origin to the same hostname users reach through Cloudflare.
- Set `TRUSTED_PROXY_MODE=cloudflare`.
- Keep security-sensitive secrets configured through the deployment environment, not hardcoded in source.
- Treat the application origin and the PostgreSQL host as separate protected dependencies.

## Origin Exposure Rules

- Keep Cloudflare proxying enabled for the public application hostname.
- Do not publish the Coolify origin IP as a second public application entrypoint.
- Restrict direct origin access so unsolicited public traffic does not bypass Cloudflare.
- If the origin must remain publicly reachable, limit ingress as tightly as the hosting environment allows and keep the public hostname proxied through Cloudflare.
- Do not rely on user-controlled forwarded headers as proof that traffic passed through Cloudflare.
- Do not expose PostgreSQL directly to the public internet as a workaround for application connectivity.

## Coolify VPS Expectations

- Coolify manages the application and PostgreSQL VPS environment and its surrounding networking.
- The VPS must not expose PostgreSQL directly to the internet.
- The reviewed VPS recovery path now uses the Coolify-managed SSH key for root access; do not store or use a root password from `.env.local` or scripts.
- Environment variables for the application and PostgreSQL host are kept in operator-controlled secret storage, not in tracked repository files.

## Cloudflare Expectations

- Use proxied DNS for the public application hostname.
- Add edge rate-limiting or managed challenge rules for login, password reset, and other abuse-prone auth endpoints.
- Keep TLS enabled from browser to Cloudflare and from Cloudflare to origin for all traffic paths.
- Review Cloudflare security events when repeated login failures, challenge spikes, or bot traffic are observed.
- Keep Cloudflare Access service token credentials for Worker-to-origin paths in Cloudflare-managed Worker secrets or CI/CD-managed storage.

## Minimum Operator Checks

Before deployment:

- Confirm the public hostname is orange-cloud proxied in Cloudflare.
- Confirm `TRUSTED_PROXY_MODE=cloudflare` is set in the backend deployment environment.
- Confirm direct backend access to PostgreSQL uses the intended reviewed hostname and TLS posture.
- Confirm root SSH recovery works with the reviewed Coolify-managed key path and that password-based root SSH login remains disabled.

After deployment:

- Load the public hostname and confirm the app responds through the reviewed Cloudflare-plus-backend deployment path.
- Confirm admin routes load through the same public hostname.
- Confirm auth logging and lockout behavior record the expected client IP source using `CF-Connecting-IP`.
- Run `pnpm verify:live-runtime -- https://awcms-mini.ahlikoding.com` to confirm the combined database posture, EmDash compatibility, and admin/setup smoke seam.

## Cross-References

- `docs/process/coolify-deployment.md`
- `docs/process/runtime-smoke-test.md`
- `docs/process/coolify-deployment.md`
- `docs/architecture/runtime-config.md`
- `docs/security/operations.md`
- `docs/process/migration-deployment-checklist.md`
