# Cloudflare And Coolify Origin Hardening

## Purpose

This runbook defines the supported public ingress pattern for AWCMS Mini when deployed behind Cloudflare and hosted through Coolify.

This is now an alternative or historical app-on-Coolify deployment path.

The current supported baseline for the repository is the Cloudflare-hosted runtime described in `docs/process/cloudflare-hosted-runtime.md`.

## Supported Production Pattern

The supported baseline production path is:

1. Browser to Cloudflare
2. Cloudflare proxied DNS to the public application hostname
3. Cloudflare to the Coolify-managed origin
4. Coolify reverse proxy to the Mini app container

This repository does not currently treat Cloudflare Tunnel as the baseline deployment pattern.

Tunnel may still be acceptable for a later deployment choice, but the operator docs and runtime expectations here assume standard proxied Cloudflare traffic with origin restriction.

## Trust Boundary Rules

- Cloudflare is the browser-facing edge.
- Coolify is the application deployment and reverse-proxy control plane.
- Mini should trust `CF-Connecting-IP` for client IP extraction when `TRUSTED_PROXY_MODE=cloudflare`.
- Mini should not trust raw `X-Forwarded-For` values for the supported production path.
- The public origin must be the Cloudflare-served hostname, not a private Coolify URL, container hostname, or direct origin IP.

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

## Coolify Expectations

- Coolify domain routing should match the intended public hostname.
- Coolify should forward requests to the Mini app without introducing a second canonical host.
- Internal app/container addresses should not be documented as browser-facing URLs.
- Environment variables in Coolify should match the runtime contract documented in `docs/architecture/runtime-config.md`.

## Cloudflare Expectations

- Use proxied DNS for the public application hostname.
- Add edge protections for login, password reset, and other abuse-prone auth endpoints.
- Keep TLS enabled from browser to Cloudflare and from Cloudflare to the origin path appropriate to the environment.
- Review Cloudflare security events when repeated login failures, challenge spikes, or bot traffic are observed.

## Minimum Operator Checks

Before deployment:

- Confirm the public hostname is orange-cloud proxied in Cloudflare.
- Confirm the same hostname is configured in Coolify for the app.
- Confirm `TRUSTED_PROXY_MODE=cloudflare` in the deployment environment.
- Confirm direct origin exposure has been reviewed and reduced.

After deployment:

- Load the public hostname and confirm the app responds through Cloudflare.
- Confirm admin routes load through the public hostname.
- Confirm auth logging and lockout behavior record the expected client IP source.
- Confirm the origin is not being used as a separate day-to-day operator entrypoint.

## Cross-References

- `docs/architecture/runtime-config.md`
- `docs/security/operations.md`
- `docs/process/migration-deployment-checklist.md`
