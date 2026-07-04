# AWCMS Mini Application Standard

## Purpose

This document defines the reusable application standard for AWCMS Mini so future applications can start from a consistent secure modular monolith baseline.

It adapts the reusable parts of the local AWPOS planning package at `/home/data/dev_bun/awpos` while preserving the higher-priority AWCMS Mini requirements:

- AWCMS Mini remains single-tenant.
- EmDash remains an architecture reference only during decoupling.
- PostgreSQL, Kysely, Hono, Astro, and Bun remain the canonical stack.
- Governance and security enforcement live in backend services and route guards.

AWPOS-specific POS, warehouse, tax, offline-node, and multi-tenant requirements are not copied into Mini unless a future product explicitly needs them and a Mini requirement update approves the scope.

## Reusable Standard

The reusable baseline for new Mini-based applications is:

- modular monolith module descriptors under `src/modules/`
- route-thin, service-first backend flow
- repository/data-access code separated from business logic
- `/api/v1` as the versioned REST API base path
- standard API envelopes for success and error responses
- domain event envelopes for transactional outbox or future event dispatch
- RBAC baseline with ABAC refinement
- audit required for privileged and high-risk actions
- idempotency for high-risk mutations
- PostgreSQL transactions with guarded transitions, atomic updates, or explicit locks
- sensitive data redaction before response, audit, search, and logging
- OpenAPI documentation for implemented API changes
- AsyncAPI-style event documentation when events are introduced

## Module Contract

The current code-level module contract lives in:

- `src/modules/_shared/module-contract.mjs`
- `src/modules/index.mjs`

Every first-party module descriptor must define:

- `key`: snake_case module key
- `name`
- `version`
- `status`: `active`, `experimental`, or `deprecated`
- `description`
- `dependencies`
- `capabilities`
- optional `api.basePath` under `/api/v1`
- optional event publish/subscribe lists
- `security.scopeModel: "single_tenant"`
- `security.authorization: "rbac_abac"`
- `security.audit: "required"`

The single-tenant scope model is intentional. AWPOS uses tenant concepts because it is a POS product plan; Mini must not introduce `tenant_id` or multi-tenant behavior unless `REQUIREMENTS.md` changes first.

## Current Standard Modules

The registry currently models existing Mini implementation areas:

| Module                | Ownership                                                            |
| --------------------- | -------------------------------------------------------------------- |
| `identity_access`     | user lifecycle, login/session controls, RBAC, ABAC, 2FA, step-up     |
| `governance_catalog`  | roles, permissions, jobs, logical regions, administrative regions    |
| `audit_observability` | structured logging, audit logs, security events, request correlation |
| `storage_delivery`    | file metadata, signed access, notifications, templates, webhooks     |
| `plugin_runtime`      | native plugin manifest, registration, route/service authorization    |
| `search_query`        | CQRS read-only projections and sensitive-field-safe search           |

These descriptors are not a second runtime framework. They are the standard boundary map for new code and future migration of existing services.

## API Contract

New Hono routes should use the standard envelope shape from `src/modules/_shared/api-response.mjs`:

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "req_...",
    "correlationId": "corr_..."
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "ACCESS_DENIED",
    "message": "Tidak punya akses.",
    "details": [],
    "correlationId": "corr_..."
  }
}
```

Do not expose stack traces, raw secrets, full NIK/NPWP-like identifiers, auth headers, tokens, password hashes, or raw R2 keys in response bodies.

## Event Contract

When a module emits an event, use `src/modules/_shared/domain-event.mjs` as the envelope baseline:

```json
{
  "eventId": "uuid",
  "eventType": "audit.log_recorded",
  "eventVersion": "1.0",
  "scope": {
    "kind": "single_tenant"
  },
  "sourceModule": "audit_observability",
  "aggregateType": "audit_log",
  "aggregateId": "uuid",
  "occurredAt": "2026-07-04T00:00:00.000Z",
  "actor": {},
  "correlationId": "corr_...",
  "causationId": "evt_...",
  "payload": {},
  "metadata": {
    "schemaVersion": "1.0"
  }
}
```

Provider calls, file delivery, notifications, future sync dispatch, and AI/tool execution must not run inside critical database transactions. Write durable intent first, then dispatch after commit.

## Request Pipeline

The standard backend flow is:

```text
HTTP route -> request ID/logger -> auth/session -> route guard/ABAC -> validation -> service -> repository/transaction -> safe DTO -> response envelope
```

Rules:

- API routes stay thin.
- Services own business decisions and transaction orchestration.
- Repositories own persistence and safe query mapping.
- Search stays in `src/search/` or module-local read-side code, not CRUD repositories.
- UI visibility is never the final authorization authority.

## Data And Concurrency

Mini uses PostgreSQL and Kysely as the canonical data layer.

For critical writes:

- prefer guarded `UPDATE ... WHERE status = expected`
- use `ON CONFLICT` for idempotent upsert behavior
- use `SELECT ... FOR UPDATE` only when complex validation needs a locked row
- use `withAdvisoryXactLock` for logical resources such as numbering or provisioning
- use `withSerializableRetry` for cross-table invariants that need serializable isolation
- never use `MAX(number)+1` for numbering

See `docs/security/database-concurrency.md`.

## Forbidden Copies From AWPOS

Do not copy the following AWPOS assumptions into Mini by default:

- multi-tenant `tenant_id` model
- POS-specific module names as core Mini modules
- checkout, warehouse, tax, and receipt requirements as base requirements
- offline node HMAC headers as universal API headers
- POS-specific roles such as cashier, warehouse staff, or tax officer as Mini defaults

Those are valid for an app built on Mini, not for the base Mini standard.

## Validation

Use targeted checks first:

```bash
bun test tests/unit/standard-module-contract.test.mjs
bun run check:architecture
```

For broader changes, use the repo baseline from `AGENTS.md`:

```bash
bun run typecheck
bun run test:unit
```
