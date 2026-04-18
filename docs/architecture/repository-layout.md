# AWCMS Mini Repository Layout

## Purpose

This document describes the current repository layout for AWCMS Mini and the ownership boundaries that keep Mini aligned with EmDash-first architecture.

This layout is constrained by:

- `docs/architecture/constraints.md`
- `awcms_mini_implementation_plan.md`
- `awcms_mini_atomic_backlog.md`

## Layout Principles

- EmDash remains the host architecture.
- The repository should not introduce a second application shell.
- Runtime, database, services, security, pages, and plugin code should stay separated by responsibility.
- Governance overlays should be additive and should not blur into EmDash core responsibilities.
- Documentation should live alongside implementation but remain clearly separated from runtime code.

## Top-Level Layout

```text
.
|-- docs/
|   |-- admin/
|   |-- architecture/
|   |-- governance/
|   |-- plugins/
|   |-- process/
|   `-- security/
|-- scripts/
|-- src/
|   |-- auth/
|   |-- config/
|   |-- db/
|   |-- integrations/
|   |-- pages/
|   |-- plugins/
|   |-- security/
|   |-- services/
|   `-- live.config.ts
|-- tests/
|   `-- unit/
|-- awcms_mini_implementation_plan.md
|-- awcms_mini_atomic_backlog.md
`-- package.json
```

## Directory Ownership

### `docs/`

- Purpose: architecture, process, operational, and feature documentation.
- Subdirectories:
  - `docs/architecture/`: constraints, layout, runtime, and database guidance
  - `docs/process/`: issue workflow, rollout, and deployment guidance
  - `docs/security/`: auth, recovery, lockouts, audit, and security operations
  - `docs/governance/`: roles, jobs, regions, and authorization guidance
  - `docs/plugins/`: plugin contract and extension guidance
  - `docs/admin/`: admin operating procedures and screen guides
- Must not contain:
  - canonical executable configuration
  - generated runtime data

### `scripts/`

- Purpose: repository automation and operator/developer scripts.
- Allowed content:
  - migration helper wrappers
  - seed or import orchestration
  - healthcheck and maintenance helpers
- Must not become:
  - the primary application runtime
  - a location for hidden business logic required by the app to function

### `src/`

- Purpose: all first-party application implementation code.
- Ownership rule: runtime code should live under `src/` unless it is clearly documentation or repository automation.

## `src/` Layout

### `src/config/`

- Purpose: runtime configuration parsing and environment mapping.
- Responsibilities:
  - environment parsing
  - runtime feature flags
  - database and security config mapping
- Must not contain:
  - side-effectful service logic

### `src/integrations/`

- Purpose: integration glue between Astro, EmDash, and Mini-specific runtime hooks.
- Responsibilities:
  - EmDash integration bootstrap
  - runtime registration helpers that belong near framework wiring
- Must not absorb:
  - domain service orchestration
  - broad business logic

### `src/db/`

- Purpose: database access foundation.
- Current internal shape:

```text
src/db/
|-- client/
|-- importers/
|-- migrations/
|-- repositories/
|-- errors.mjs
|-- index.mjs
`-- transactions.mjs
```

- Responsibilities:
  - PostgreSQL connection setup
  - Kysely client wiring
  - migrations and repositories
  - transaction helpers and database error classification
- Must not contain:
  - admin presentation code
  - plugin UI logic

### `src/auth/`

- Purpose: auth and session implementation on top of EmDash's auth boundary.
- Responsibilities:
  - login/logout handlers
  - session orchestration
  - password reset flows
  - TOTP challenge and verification support
  - step-up auth helpers
- Must not contain:
  - broad business-domain workflows unrelated to identity/security

### `src/pages/`

- Purpose: Astro route entrypoints and public/runtime-facing endpoints.
- Responsibilities:
  - API route files such as `src/pages/api/reset-password.js`
  - route-level entrypoints that hand off to Mini auth or service handlers
- Constraint:
  - route files should remain thin and delegate real workflow logic to auth handlers or services

### `src/security/`

- Purpose: reusable security-focused helpers and contracts shared across auth and service code.
- Responsibilities:
  - runtime rate-limit coordination
  - trusted client IP resolution
  - TOTP and security-policy helpers
- Must not contain:
  - plugin-specific UI logic
  - direct page rendering code

### `src/services/`

- Purpose: domain orchestration and business operations.
- Current service groups include:

```text
src/services/
|-- administrative-regions/
|-- audit/
|-- authorization/
|-- jobs/
|-- permissions/
|-- rbac/
|-- regions/
|-- roles/
|-- security/
|-- sessions/
`-- users/
```

- Responsibilities:
  - coordinate repositories
  - enforce transaction boundaries
  - expose reusable domain operations to auth handlers and plugins
  - own explicit soft-delete and restore workflows when lifecycle rules need audit or operator attribution
- Must not contain:
  - direct UI rendering logic
  - ad hoc route-level authorization duplication

### `src/plugins/`

- Purpose: first-party internal plugins and plugin integration support.
- Responsibilities:
  - EmDash plugin definitions via `definePlugin(...)`
  - plugin descriptors used for host registration
  - plugin contracts and helpers
  - first-party plugin implementation such as `awcms-users-admin`
- Constraint:
  - plugin integration should use shared services and policy helpers

### `src/live.config.ts`

- Purpose: repository-level live configuration entrypoint when the host runtime expects it.
- Constraint:
  - keep runtime-specific configuration close to the framework boundary and out of service code

## `tests/` Layout

```text
tests/
`-- unit/
```

- `tests/unit/`: repository, service, auth-handler, plugin-helper, and admin-route unit coverage

Test layout should mirror `src/` ownership where practical.

## Ownership Boundaries

### Runtime vs Services

- `src/pages/`, `src/auth/`, and `src/integrations/` provide runtime entrypoints and framework wiring.
- `src/services/` owns domain operations.
- runtime code should call services rather than embed workflow logic inline.

### Services vs Repositories

- repositories in `src/db/repositories/` handle data persistence and retrieval.
- services coordinate repositories and transactions.
- services should not duplicate low-level query logic across the codebase.

### Services vs Security And Authorization

- authorization logic currently lives under `src/services/authorization/` and related security modules.
- `src/services/` performs the action once permission and policy checks allow it.
- admin UI should never be the final authority.

### Admin vs Plugins

- first-party admin experience currently ships through the `awcms-users-admin` EmDash plugin.
- `src/plugins/` owns plugin registration, admin route wiring, plugin descriptors, and plugin-specific logic.
- admin pages for plugin features should still consume shared services and policy helpers.

## Path Naming Guidance

- use singular or plural names consistently by domain, not arbitrarily
- keep path names short and literal
- prefer `administrative-regions` over vague alternatives like `geo`
- keep security-sensitive code in `src/auth/` or `src/services/security/`, not scattered

## Growth Rules

- Do not create directories before there is a concrete issue requiring them.
- When a new directory is proposed, it should have a clear ownership boundary.
- If a feature starts to span multiple domains, prefer keeping composition in services rather than introducing a new top-level application layer.
- If EmDash already provides the relevant location or extension seam, use that seam instead of inventing a parallel structure.

## Forbidden Layout Patterns

- a second standalone admin application tree
- mixed database and UI code in the same module
- policy logic scattered directly across pages and handlers
- plugin-specific direct database writes that bypass shared services without an explicit reason
- multi-tenant foldering patterns such as `tenants/` or `workspace/`
- generic `misc/`, `helpers/`, or `shared/` directories that accumulate unrelated business logic

## Decision Rule

If a proposed file placement conflicts with this document, prefer the simplest location that:

- preserves EmDash-first architecture,
- keeps database, service, security, and UI concerns separate,
- avoids introducing a second platform core,
- stays compatible with the issue-driven workflow.

If the conflict is still unresolved, stop and open a new GitHub issue before continuing.
