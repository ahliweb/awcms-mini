# Operator Cloudflared Removal Checklist (#268)

## Scope

Operator-side removal of Cloudflare Tunnel (`cloudflared`) from Coolify/VPS runtime where no longer required.

## Current Reviewed Posture

- The reviewed server posture reports `isCloudflareTunnel=false`.
- PostgreSQL remains private on the Coolify-managed VPS and is not publicly exposed.
- The supported path remains Cloudflare frontend delivery plus Hono on Coolify.

## Canonical References

- Cloudflare Tunnel token security guidance:
  - rotate compromised token
  - remove active tunnel connections
  - uninstall service on replicas

## Checklist

1. Identify any running `cloudflared` services/containers on host.
2. Disable and uninstall `cloudflared` service on each host/replica.
3. Remove tunnel token and tunnel-specific env vars from runtime config.
4. Rotate tunnel token in Cloudflare account (even if removing) and revoke active connections.
5. Verify no `cloudflared` process remains running.
6. Re-validate backend health and frontend API reachability through supported path.

## Required Evidence To Attach On #268

- Redacted host/service output showing `cloudflared` absent.
- Cloudflare-side evidence of token rotation/revocation and no active connectors.
- Post-removal runtime checks:
  - `pnpm healthcheck`
  - `pnpm verify:live-runtime -- <site-url>`

## Safety Notes

- Do not expose PostgreSQL publicly during or after tunnel cleanup.
- Keep supported access model: frontend/API traffic through reviewed Cloudflare + Hono path.
