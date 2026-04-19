# Cloudflare Hyperdrive Decision

## Purpose

This document records the current architecture decision for whether AWCMS Mini should adopt Cloudflare Hyperdrive for PostgreSQL access from the Cloudflare-hosted Worker runtime.

## Decision

For the next deployment phase, Hyperdrive is recommended as the preferred transport and pooling layer for PostgreSQL access from the Cloudflare-hosted runtime.

It is not enabled in the current repository baseline yet.

The current baseline remains:

- direct PostgreSQL access through `DATABASE_URL`
- reviewed SSL posture using `id1.ahlikoding.com`
- Cloudflare-hosted Worker runtime with Coolify-managed PostgreSQL on the VPS

Adopting Hyperdrive should happen in a separate implementation issue so the runtime seam, deployment config, and operator rollout stay reviewable.

## Why This Is The Decision

Cloudflare's current guidance for Workers and Hyperdrive recommends Hyperdrive for remote PostgreSQL access from Workers because it provides regional pooling and avoids paying the full connection setup cost on every request.

That aligns with AWCMS Mini's current deployment shape:

- Worker-hosted runtime on Cloudflare
- remote PostgreSQL on a Coolify-managed VPS
- existing direct TLS posture already documented and hardened

## Why It Is Not Enabled Immediately

The current repository database seam still uses direct `DATABASE_URL` transport.

The implementation change is not just a deployment toggle. It requires explicit review of:

- how the PostgreSQL client is instantiated for Worker requests
- how Hyperdrive bindings are configured in `wrangler.jsonc`
- how local development continues to use a direct local or reviewed remote connection string
- how deployment secrets and smoke tests distinguish direct versus Hyperdrive-backed transport

That is a separate implementation task, not a documentation-only decision.

## Current Repository Context

- `src/db/client/postgres.mjs` keeps `DATABASE_URL` as the current source of truth for direct transport settings
- `wrangler.jsonc` already contains commented Hyperdrive placeholders
- operator docs already treat Hyperdrive as a follow-on transport layer rather than a replacement for PostgreSQL TLS, ingress review, or least-privilege credentials
- the reviewed browser-facing baseline remains a single Worker-hosted runtime on `https://awcms-mini.ahlikoding.com`

## Recommended Implementation Shape

If Hyperdrive is adopted in a follow-on issue, keep the change minimal and explicit:

1. add the reviewed Hyperdrive binding to `wrangler.jsonc`
2. add runtime config that distinguishes direct `DATABASE_URL` transport from Hyperdrive-backed transport
3. update the PostgreSQL client seam so Worker-hosted requests can use the Hyperdrive connection string correctly
4. keep local development and non-Hyperdrive environments working without forcing Hyperdrive everywhere
5. update smoke tests, deployment checks, and rollback guidance for the new transport path

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
