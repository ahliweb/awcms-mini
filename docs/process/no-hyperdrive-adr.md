# No-Hyperdrive Architecture Decision Record

## Status

**Superseded** — the prior Hyperdrive decision in `docs/process/cloudflare-hyperdrive-decision.md`
is archived as historical context. This document records the current active decision.

## Decision

AWCMS Mini does **not** use Cloudflare Hyperdrive in the target architecture.

## Target Architecture

```
Cloudflare Pages (frontend)
        |
        v
Hono Backend API — Coolify-managed VPS
        |
        +--> PostgreSQL Docker service (internal Docker network, same VPS)
        |
        +--> Cloudflare R2 (object storage)
        |
        +--> Mailketing Email API
        |
        +--> Starsender WhatsApp API
```

The Hono backend API on the Coolify-managed VPS is the **only** approved layer for
PostgreSQL access. No Cloudflare edge component (Pages, Workers) connects to
PostgreSQL directly.

## Rationale

1. **Architecture clarity** — routing all database access through a single
   backend API removes the need to manage Hyperdrive bindings, tunnel
   configuration, and edge-to-database credential posture separately.

2. **Operational simplicity** — Coolify manages service lifecycle, environment
   variables, and deployment without requiring Wrangler-level Hyperdrive
   provisioning steps.

3. **Security posture** — the database remains inside the VPS Docker network and
   is never reachable from Cloudflare edge infrastructure directly.

4. **Separation of concerns** — Cloudflare Pages is a static/frontend host.
   Business logic, authorization, and data access all live in the Hono backend.

5. **EmDash-first alignment** — EmDash extensions, plugins, and governance
   services remain in the backend codebase and do not require edge-compatible
   transport abstractions.

## What This Means for the Repository

- `DATABASE_TRANSPORT` defaults to `direct`.
- `HYPERDRIVE_BINDING` configuration in `wrangler.jsonc` is removed from the
  active architecture path.
- `src/db/client/postgres.mjs` retains the transport seam but `hyperdrive` is
  not the active selection in production.
- All deployment documentation targets Coolify + Hono, not Cloudflare Workers.
- The `wrangler.jsonc` file is retained only insofar as it is needed for any
  Cloudflare Pages build integration; Hyperdrive bindings are removed from it.

## Constraints

- Do not add Hyperdrive bindings to `wrangler.jsonc`.
- Do not add `HYPERDRIVE_*` environment variables to Coolify or `.env.example`
  as active production variables.
- Do not connect Cloudflare Pages or any frontend code to PostgreSQL directly.
- Do not add Cloudflare Tunnel configuration for the purpose of Hyperdrive
  private-database access.

## Superseded Document

`docs/process/cloudflare-hyperdrive-decision.md` — retained as historical
reference only. It reflects a prior evaluated path that was not adopted as the
production baseline for this architecture.

## Cross-References

- `docs/architecture/overview.md`
- `docs/architecture/runtime-config.md`
- `docs/process/cloudflare-coolify-origin-hardening.md`
- `docs/process/postgresql-vps-hardening.md`
