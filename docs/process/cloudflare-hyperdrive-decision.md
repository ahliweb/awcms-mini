# Cloudflare Hyperdrive Decision

## Purpose

This document records the current architecture decision for whether AWCMS Mini should adopt Cloudflare Hyperdrive for PostgreSQL access from the Cloudflare-hosted Worker runtime.

## Decision

For the next deployment phase, Hyperdrive is recommended as the preferred transport and pooling layer for PostgreSQL access from the Cloudflare-hosted runtime.

It is not enabled in the live deployment baseline yet.

The current baseline remains:

- direct PostgreSQL access through `DATABASE_URL`
- reviewed SSL posture using `id1.ahlikoding.com`
- Cloudflare-hosted Worker runtime with Coolify-managed PostgreSQL on the VPS

The repository already includes the runtime transport seam for Hyperdrive selection, but live binding enablement and operator rollout remain separate so deployment config and origin connectivity stay reviewable.

## Why This Is The Decision

Cloudflare's current guidance for Workers and Hyperdrive recommends Hyperdrive for remote PostgreSQL access from Workers because it provides regional pooling and avoids paying the full connection setup cost on every request.

That aligns with AWCMS Mini's current deployment shape:

- Worker-hosted runtime on Cloudflare
- remote PostgreSQL on a Coolify-managed VPS
- existing direct TLS posture already documented and hardened

## Why It Is Not Enabled Immediately

The current default deployment path still uses direct `DATABASE_URL` transport.

The implementation change is not just a deployment toggle. It requires explicit review of:

- how the PostgreSQL client is instantiated for Worker requests
- how Hyperdrive bindings are configured in `wrangler.jsonc`
- how local development continues to use a direct local or reviewed remote connection string
- how deployment secrets and smoke tests distinguish direct versus Hyperdrive-backed transport

The remaining work is now primarily deployment and operator rollout, not a documentation-only decision.

## Current Repository Context

- `src/config/runtime.mjs` and `src/db/client/postgres.mjs` already support explicit `DATABASE_TRANSPORT` selection and Hyperdrive binding resolution
- `wrangler.jsonc` keeps direct transport as the default while leaving the reviewed Hyperdrive binding block commented until a live Hyperdrive configuration ID is available
- operator docs already treat Hyperdrive as a follow-on transport layer rather than a replacement for PostgreSQL TLS, ingress review, or least-privilege credentials
- the reviewed browser-facing baseline remains a single Worker-hosted runtime on `https://awcms-mini.ahlikoding.com`

## Recommended Implementation Shape

For live Hyperdrive enablement, keep the remaining change minimal and explicit:

1. add the reviewed Hyperdrive binding ID to `wrangler.jsonc`
2. keep `DATABASE_TRANSPORT=direct` as the default until the target deployment intentionally switches
3. keep local development and non-Hyperdrive environments working without forcing Hyperdrive everywhere
4. update smoke tests, deployment checks, and rollback guidance for the live transport switch

## Operator Prerequisites

- non-interactive Wrangler commands require `CLOUDFLARE_API_TOKEN`
- the deployment operator needs a reviewed Hyperdrive configuration ID before enabling the binding in `wrangler.jsonc`
- the PostgreSQL origin must accept the reviewed Cloudflare-to-origin connection path before `wrangler hyperdrive create` can succeed
- the Hyperdrive origin hostname must resolve to a reachable PostgreSQL origin path for Cloudflare, not just to Cloudflare edge IPs on a web-proxied hostname
- if account inventory is not readable through the available Cloudflare management path, treat Hyperdrive binding enablement as an operator-side rollout step rather than a repository-only change

Supported operator choices for the origin endpoint:

1. use a reviewed reachable public PostgreSQL origin hostname or IP path that Cloudflare can connect to directly
2. if the database should stay private, use Cloudflare Tunnel and the private-database Hyperdrive path instead of trying to reuse a normal web-proxied hostname

Preferred default for the current environment:

- prefer the private-database Hyperdrive path via Cloudflare Tunnel unless there is a reviewed operator reason to expose a separately reachable PostgreSQL origin endpoint
- keep the reachable public-origin path as the fallback option when Tunnel is not viable for the target environment

Private-database Tunnel prerequisites:

1. a reviewed Cloudflare Tunnel that can reach the PostgreSQL origin on port `5432`
2. a reviewed TCP public hostname or equivalent private-database route for the tunnel-backed origin
3. Cloudflare Access/service-token material if the Hyperdrive configuration will authenticate to the tunnel-backed origin through Access
4. explicit tunnel-side and PostgreSQL-side notes showing how the private origin path maps back to the Coolify-managed VPS
5. a `CLOUDFLARE_API_TOKEN` with tunnel permissions, including `Account > Cloudflare Tunnel > Edit`, for non-interactive tunnel provisioning through Wrangler
6. operator access to the Cloudflare dashboard or API for ingress-rule management, because Wrangler-created tunnels are remotely managed and do not expose ingress configuration through the current tunnel CLI surface

Reviewed default route name:

- prefer `pg-hyperdrive.ahlikoding.com` for the tunnel-backed private-database route because it is explicit, operator-only, and distinct from the public app hostname
- avoid reusing `awcms-mini.ahlikoding.com`, `id1.ahlikoding.com`, or any general web-facing hostname for the Hyperdrive route

## Security Implications

- Hyperdrive is a transport and pooling layer, not a replacement for PostgreSQL SSL, restricted ingress, or app-scoped credentials
- the reviewed PostgreSQL hostname, certificate expectations, and operator rollback rules remain relevant even if Hyperdrive is adopted
- secrets and bindings should remain server-only and environment-managed
- least privilege and audited rollout sequencing still apply

## What Would Reopen This Decision

Revisit this decision only if one of the following changes materially:

- Cloudflare changes Hyperdrive guidance for Workers and PostgreSQL
- the current direct PostgreSQL path proves operationally sufficient without meaningful connection pressure or latency cost
- AWCMS Mini moves to a different supported runtime or database transport model

Absent one of those changes, Hyperdrive remains the recommended next-step transport improvement for the Cloudflare-hosted runtime.

## Validation

- docs review against the current repository state
- `pnpm lint`

## Cross-References

- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
- `docs/architecture/runtime-config.md`
- `README.md`
