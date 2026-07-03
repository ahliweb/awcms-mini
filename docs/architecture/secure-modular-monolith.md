# Secure Modular Monolith

## Purpose

This document defines the default architecture standard for AWCMS Mini.

AWCMS Mini is a secure modular monolith: one deployable application with clear module boundaries, service-layer security enforcement, PostgreSQL ownership rules, and an extraction path if a module ever needs to become a separate service.

## Canonical Position

- Runtime and toolchain: Bun.
- Source language: JavaScript and TypeScript as required by the implementation.
- TypeScript is still used for type safety, DTOs, generated types, and refactor safety where the codebase needs it. Bun does not replace TypeScript as a type system.
- Backend stack: Astro route surface plus Hono API.
- Database: PostgreSQL through Kysely.
- CMS seam: `src/cms/`.
- EmDash is an architecture reference during decoupling, not a runtime dependency target.

## Module Shape

New first-party bounded contexts should use this shape when a real issue requires a module:

```text
src/modules/{module}/
|-- public/
|   |-- {module}.port.ts
|   |-- {module}.dto.ts
|   `-- index.ts
|-- internal/
|   |-- {module}.service.ts
|   |-- {module}.repository.ts
|   |-- {module}.routes.ts
|   |-- {module}.policy.ts
|   `-- {module}.audit.ts
|-- migrations/
`-- tests/
```

Use the existing `src/auth/`, `src/services/`, `src/plugins/`, and `src/db/` layout until a module boundary is justified. Do not move code into `src/modules/` just to satisfy this template.

## Boundary Rules

- Other modules may import only from `src/modules/{module}/public`.
- Direct imports into another module's `internal` directory are forbidden.
- Cross-module calls should go through a port, interface, or client exposed by `public`.
- Direct repository calls across modules are forbidden for domain workflows.
- Batch contracts should be preferred when a cross-module read would otherwise create N+1 queries.
- Events or projections are preferred for audit, notification, indexing, and read-model updates.

These rules are guarded by `tests/unit/module-boundaries.test.mjs`.

## Database Ownership

- Each module owns its tables, migrations, repository code, and write invariants.
- PostgreSQL remains the only system-of-record database.
- Kysely remains the canonical migration and query layer.
- Foreign keys are preferred inside one module.
- Cross-module foreign keys require an explicit ADR or issue decision.
- Cross-module references should use logical IDs and snapshot fields when the domain can tolerate eventual reconciliation.
- A reconciliation report or job should be added when orphan detection matters operationally.

## Concurrency And Integrity

All write paths must follow `docs/security/database-concurrency.md`.

Use:

- atomic updates for counters, quotas, and guarded limits
- expected-current-status predicates for workflow transitions
- `ON CONFLICT` for create-if-not-exists
- `SELECT ... FOR UPDATE` when validation needs a locked row
- `withAdvisoryXactLock` for logical resources such as numbering or provisioning
- `withSerializableRetry` for complex cross-row or cross-table invariants

Never generate numbering with `MAX(number) + 1` without a lock or sequence strategy.

## Security Baseline Per Module

Every module must document or implement:

- authentication and route authorization
- RBAC permission names and ABAC refinements where relevant
- input validation and output DTOs
- sensitive-field masking
- parameterized database access through Kysely
- RLS/session context when the table requires it
- audit events for privileged or sensitive operations
- rate limiting for public or abuse-prone endpoints
- safe upload/download handling when files are involved
- CORS and secure header behavior for exposed routes
- error responses that do not leak stack traces or secrets
- backup, recovery, and incident-response notes when data loss or integrity risk exists

## Bun And TypeScript Policy

- `bun.lock` is the authoritative dependency lockfile.
- Use Bun for install, dev, build, start, migrations, and smoke scripts when compatible.
- Keep `node --test` as the unit-test runner until Bun supports this suite shape reliably.
- Keep `bun run typecheck` when TypeScript, Astro types, or generated contracts exist.
- Do not use Bun-only APIs in code that runs on Cloudflare Workers.
- Verify native dependencies in the Docker/Coolify target before treating a runtime path as production-ready.

## Validation

Issue-scoped changes should run the narrowest useful checks first, then the broader checks when the change touches shared behavior.

Recommended checks:

```bash
bun run check:architecture
bun run test:unit
bun run typecheck
bun run check
```

Use live smoke checks only when the issue touches runtime deployment, admin routing, database transport, or security enforcement that cannot be proven locally.

## Cross-References

- `docs/architecture/constraints.md`
- `docs/architecture/overview.md`
- `docs/architecture/repository-layout.md`
- `docs/architecture/emdash-touchpoint-inventory.md`
- `docs/security/database-concurrency.md`
- `docs/process/github-issue-workflow.md`
