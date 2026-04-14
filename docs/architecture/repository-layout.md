# AWCMS Mini Repository Layout

## Purpose

This document defines the repository module layout for AWCMS Mini before implementation expands. It is the canonical location and ownership map for runtime code, database code, services, policy code, admin extensions, plugins, and documentation.

This layout is constrained by:

- `docs/architecture/constraints.md`
- `awcms_mini_implementation_plan.md`
- `awcms_mini_atomic_backlog.md`

## Layout Principles

- EmDash remains the host architecture.
- The repository should not introduce a second application shell.
- Runtime, database, services, policy, admin, and plugin code should be separated by responsibility.
- Governance overlays should be additive and should not blur into EmDash core responsibilities.
- Documentation should live alongside implementation but remain clearly separated from runtime code.

## Top-Level Layout

```text
.
|-- .github/
|-- docs/
|   |-- architecture/
|   |-- process/
|   |-- security/
|   |-- governance/
|   |-- plugins/
|   `-- admin/
|-- scripts/
|-- src/
|   |-- app/
|   |-- config/
|   |-- db/
|   |-- auth/
|   |-- services/
|   |-- policy/
|   |-- admin/
|   |-- plugins/
|   |-- content/
|   |-- lib/
|   `-- types/
|-- tests/
|   |-- unit/
|   |-- integration/
|   `-- e2e/
|-- awcms_mini_implementation_plan.md
|-- awcms_mini_atomic_backlog.md
`-- package.json
```

Not every directory needs to exist immediately. This layout defines the target structure that implementation issues should grow into.

## Directory Ownership

### `.github/`

- Purpose: repository automation, issue templates, PR templates, and workflow metadata.
- Allowed content:
  - issue forms
  - workflow policy docs
  - CI workflows
- Must not contain:
  - business logic
  - runtime application code

### `docs/`

- Purpose: architecture, process, operational, and feature documentation.
- Subdirectories:
  - `docs/architecture/`: constraints, layout, architecture decisions
  - `docs/process/`: issue workflow, contribution process, rollout process
  - `docs/security/`: auth, 2FA, lockouts, audit, recovery guides
  - `docs/governance/`: roles, jobs, regions, ABAC model
  - `docs/plugins/`: plugin contract and extension guidance
  - `docs/admin/`: admin operating procedures and screen guides
- Must not contain:
  - canonical executable configuration
  - generated runtime data

### `scripts/`

- Purpose: repository automation and operator/developer scripts.
- Allowed content:
  - backlog-to-issue automation
  - migration helper wrappers
  - import or seed orchestration scripts
- Must not become:
  - the primary application runtime
  - a location for hidden business logic required by the app to function

### `src/`

- Purpose: all first-party application implementation code.
- Ownership rule: runtime code should live under `src/` unless it is clearly documentation or repository automation.

## `src/` Layout

### `src/app/`

- Purpose: top-level application bootstrapping and EmDash host wiring.
- Responsibilities:
  - runtime entrypoints
  - EmDash integration bootstrap
  - app-level composition
- Must not absorb:
  - domain business rules
  - database query implementation

### `src/config/`

- Purpose: typed application configuration.
- Responsibilities:
  - environment parsing
  - runtime feature flags
  - database and security config mapping
- Must not contain:
  - side-effectful service logic

### `src/db/`

- Purpose: database access foundation.
- Recommended internal shape:

```text
src/db/
|-- client/
|-- migrations/
|-- seeds/
|-- repositories/
|-- transactions/
`-- schema/
```

- Responsibilities:
  - PostgreSQL connection setup
  - Kysely dialect and client wiring
  - migration files
  - seed files
  - repository implementations
  - transaction helpers
  - schema typing support
- Must not contain:
  - ABAC policy decisions
  - admin presentation code

### `src/auth/`

- Purpose: auth and session implementation on top of EmDash's auth boundary.
- Responsibilities:
  - login/logout handlers
  - session orchestration
  - password flows
  - TOTP challenge and verification support
  - step-up auth helpers
- Must not contain:
  - broad business-domain workflows unrelated to identity/security

### `src/services/`

- Purpose: domain orchestration and business operations.
- Recommended service groups:

```text
src/services/
|-- users/
|-- roles/
|-- permissions/
|-- jobs/
|-- regions/
|-- administrative-regions/
|-- security/
|-- audit/
`-- content/
```

- Responsibilities:
  - coordinate repositories
  - enforce transaction boundaries
  - expose reusable domain operations to admin routes and plugins
- Must not contain:
  - direct UI rendering logic
  - ad hoc route-level authorization duplication

### `src/policy/`

- Purpose: centralized authorization and policy evaluation.
- Responsibilities:
  - RBAC resolution helpers
  - ABAC evaluation engine
  - actor-target comparison rules
  - region and job context evaluation helpers
  - cache/invalidation logic for effective policy state
- Must not contain:
  - raw SQL repository logic
  - page or component rendering logic

### `src/admin/`

- Purpose: EmDash admin extensions for Mini governance functionality.
- Recommended internal shape:

```text
src/admin/
|-- pages/
|-- routes/
|-- components/
|-- forms/
`-- navigation/
```

- Responsibilities:
  - admin pages
  - admin route handlers/actions
  - governance forms and UI composition
  - admin navigation registration
- Constraint:
  - this must extend EmDash admin rather than replace it

### `src/plugins/`

- Purpose: first-party internal plugins and plugin integration support.
- Recommended internal shape:

```text
src/plugins/
|-- core/
|-- governance/
|-- registry/
`-- contracts/
```

- Responsibilities:
  - plugin registration
  - plugin contracts and helpers
  - first-party plugin implementation
- Constraint:
  - plugin integration should use shared services and policy helpers

### `src/content/`

- Purpose: content model integration that remains within EmDash's content architecture.
- Responsibilities:
  - collection definitions
  - content-related extension glue
  - optional content governance hooks
- Constraint:
  - do not recreate a second content framework here

### `src/lib/`

- Purpose: low-level shared helpers that do not belong to a domain service.
- Allowed content:
  - pure utilities
  - shared formatting/parsing helpers
  - generic infrastructure adapters
- Constraint:
  - `src/lib/` should not become a dumping ground for uncategorized business logic

### `src/types/`

- Purpose: shared types that are used across multiple domains.
- Allowed content:
  - request context types
  - shared domain enums/types
  - integration contract types
- Constraint:
  - domain-local types should stay near the owning module when possible

## `tests/` Layout

```text
tests/
|-- unit/
|-- integration/
`-- e2e/
```

- `tests/unit/`: repository, service, and policy unit tests
- `tests/integration/`: database, auth, admin action, and policy integration tests
- `tests/e2e/`: key admin and security workflows when they exist

Test layout should mirror `src/` ownership where practical.

## Ownership Boundaries

### Runtime vs Services

- `src/app/` wires runtime behavior.
- `src/services/` owns domain operations.
- runtime code should call services rather than embed workflow logic inline.

### Services vs Repositories

- repositories in `src/db/repositories/` handle data persistence and retrieval.
- services coordinate repositories and transactions.
- services should not duplicate low-level query logic across the codebase.

### Services vs Policy

- `src/policy/` decides whether actions are allowed.
- `src/services/` performs the action once policy allows it.
- admin UI should never be the final authority.

### Admin vs Plugins

- `src/admin/` owns first-party admin experience.
- `src/plugins/` owns plugin registration and plugin-specific logic.
- admin pages for plugin features should still consume shared services and policy helpers.

## Path Naming Guidance

- use singular or plural names consistently by domain, not arbitrarily
- keep path names short and literal
- prefer `administrative-regions` over vague alternatives like `geo`
- prefer `policy` over multiple overlapping authz helper folders
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

## Initial Recommended Creation Order

The repository does not need the full layout immediately. The first concrete implementation issues should typically create these locations in order:

1. `src/app/`
2. `src/config/`
3. `src/db/`
4. `src/auth/`
5. `src/services/`
6. `src/admin/`
7. `tests/unit/`
8. `tests/integration/`

Later issues should add `src/policy/`, `src/plugins/`, `src/content/`, and governance-specific documentation directories as the implementation reaches those concerns.

## Decision Rule

If a proposed file placement conflicts with this document, prefer the simplest location that:

- preserves EmDash-first architecture,
- keeps database, service, policy, and UI concerns separate,
- avoids introducing a second platform core,
- stays compatible with the issue-driven workflow.

If the conflict is still unresolved, stop and open a new GitHub issue before continuing.
