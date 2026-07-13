---
"awcms-mini": minor
---

Make database pool and work-class budgets deployment-aware, and validate
horizontal connection capacity before deployment (Issue #743, epic #738
platform-evolution, Wave 1).

Adds a typed capacity model (`src/lib/database/capacity-config.ts`) that
sums `instance_count[class] x pool_max[class] + reserved_headroom` across
every database-using process class (`app`/`worker`/`setup`) and validates
it against an approved PgBouncer/PostgreSQL connection budget — the
concrete "10 instances x pool_max 20 = 200 connections vs. an 80-connection
approved budget = connection storm" scenario the issue describes. A new,
read-only `database:capacity` stage in `bun run production:preflight`
(also runnable standalone via `bun run database:capacity:check`) fails
before go-live when the configured horizontal ceiling would exceed the
approved budget, or when the capacity configuration is otherwise unsafe or
internally inconsistent. PgBouncer transaction-pooling and direct-
PostgreSQL profiles are validated with separate, correct assumptions.

Extends existing pooling/backpressure mechanism (Issues #682/#684/#698/
#699) rather than replacing it:

- `src/lib/database/client.ts` — pool `max` can now be sized independently
  per process class (`DATABASE_POOL_MAX_WORKER`/`DATABASE_POOL_MAX_SETUP`,
  both optional, falling back to `DATABASE_POOL_MAX` for full backward
  compatibility).
- `src/lib/database/work-class.ts` — the per-work-class FIFO queue is now
  BOUNDED (`DATABASE_WORK_CLASS_QUEUE_MULTIPLIER`, default 4x a class's own
  concurrency max). Once a class's queue is full, a new caller is rejected
  IMMEDIATELY (`WorkClassQueueFullError`) instead of joining an
  ever-growing queue and eventually timing out — closing a "cascading
  timeout chain" gap in the existing graceful-saturation design.
- `src/lib/database/tenant-context.ts` — every `503 DATABASE_BUSY`
  `withTenant` can return (circuit-open, work-class timeout, or the new
  bounded-queue rejection) now carries a `Retry-After` header.
- A new endpoint/operation-to-work-class registry
  (`src/lib/database/work-class-registry.ts` for background jobs,
  auto-generated `docs/awcms-mini/work-class-registry.generated.json` for
  every `withTenant`-calling API route) with a CI drift gate
  (`bun run db:work-class:check`, part of `bun run check`) that fails when
  a new route or worker job is added without an explicit, reviewable
  work-class classification.
- `GET /api/v1/database/pool/health` additively reports a `capacity`
  summary and each work class's `maxQueueDepth` (OpenAPI updated).
- New low-cardinality metrics: `db_pool_work_class_rejected_total`,
  `db_pool_work_class_wait_ms`, `db_pool_capacity_configured_connections`,
  `db_pool_capacity_estimated_total_connections`,
  `db_pool_capacity_approved_budget`.

Every new environment variable is optional with a conservative default
that reproduces the pre-#743 single-instance offline/LAN topology —
`bun run database:capacity:check` passes with zero of them set, and no
existing deployment's `.env` needs to change. Preflight and the capacity
calculator are strictly read-only and never modify pool/database
configuration. See `docs/awcms-mini/database-capacity-runbook.md` for the
full model, a worked sizing example, and the incident-response procedure
for saturation/connection-storm events.
