# AWCMS Mini Architecture Overview

## Purpose

This document summarizes the current system shape for operators and contributors after the main governance, security, admin, and plugin contract work has landed.

## Core Split

### EmDash Core

EmDash remains the host architecture.

EmDash owns:

- the Astro-based runtime shell
- the admin host and plugin surface
- the CMS-oriented route and integration model
- the baseline auth/session boundary that Mini extends rather than replaces

### Mini Overlay

AWCMS Mini adds governance overlays on top of EmDash.

Mini owns:

- user governance and lifecycle controls
- explicit RBAC and ABAC services
- role hierarchy metadata and protection rules
- job hierarchy and assignment history
- logical and administrative region governance
- 2FA, lockouts, step-up, password-reset recovery, and session controls
- audit logs and security events
- governance-aware plugin contracts

## Runtime Stack

- Frontend hosting: Cloudflare Pages
- Backend API: Hono on a Coolify-managed VPS
- Database: PostgreSQL running as a Docker service on the same VPS
- Object storage: Cloudflare R2
- Query and migration layer: Kysely
- Extension model: internal EmDash-compatible plugins
- Admin surface: EmDash admin extended by Mini governance pages
- Email notifications: Mailketing Email API (backend-only)
- WhatsApp notifications: Starsender WhatsApp API (backend-only)

## Deployment Topology

```
Cloudflare Pages (frontend)
        |
        v (HTTPS API calls via PUBLIC_API_BASE_URL)
Hono Backend API — Coolify-managed VPS
        |
        +--> PostgreSQL Docker service (internal Docker network)
        |
        +--> Cloudflare R2 (object storage, signed URLs)
        |
        +--> Mailketing Email API
        |
        +--> Starsender WhatsApp API
```

PostgreSQL is not exposed to the public internet. All database access goes through the Hono backend API.

Cloudflare Hyperdrive is not used in this architecture. See `docs/process/no-hyperdrive-adr.md`.

## Layer Map

### Host Layer

EmDash provides the application shell and extension seams.

### Database Layer

Mini uses PostgreSQL as the single system of record and Kysely for:

- migrations
- repositories
- transactions
- explicit SQL-oriented data access

### Governance Layer

Mini overlays service-layer policy and support tables for:

- roles and permissions
- ABAC evaluation
- jobs
- logical regions
- administrative regions
- security and audit concerns

### Plugin Layer

Mini extends EmDash through internal plugins instead of introducing a second framework core.

The current contract includes:

- plugin permission registration
- plugin route authorization helper
- plugin service authorization helper
- plugin audit helper
- plugin region-awareness helper
- plugin descriptors that register first-party plugins with EmDash

## Primary Admin Surface

The main governance extension is `awcms-users-admin`.

It provides:

- user list and user detail tabs
- roles and permission matrix views
- jobs and titles/levels views
- logical and administrative region views
- sessions and login history views
- security settings and 2FA reset operations
- audit log view

## Operational Priorities

The current implementation is optimized for:

- single-tenant simplicity
- explicit service-layer enforcement
- additive rollout safety
- operator-visible auditability
- recoverable governance changes

## Cross-References

- `docs/architecture/constraints.md`
- `docs/architecture/runtime-config.md`
- `docs/architecture/repository-layout.md`
- `docs/process/no-hyperdrive-adr.md`
- `docs/governance/auth-and-authorization.md`
- `docs/governance/permission-matrix.md`
- `docs/governance/roles.md`
- `docs/governance/jobs.md`
- `docs/governance/regions.md`
- `docs/security/operations.md`
- `docs/process/cloudflare-coolify-origin-hardening.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/plugins/contract-overview.md`
- `docs/admin/operations-guide.md`
