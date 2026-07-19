---
"awcms-mini": minor
---

feat(tenant-entitlement): compute and enforce effective features, modules, quotas, and overrides (#871)

Adds the `tenant_entitlement` module — the second SaaS control-plane module and
the heart of epic #868 (ADR-0022), and the first tenant-scoped one. It derives a
tenant's deterministic, explainable effective feature/module/quota entitlement
from published `service_catalog` offers (read via the `service_catalog_read`
port), trial/grace effective-dating, operator overrides (grant/deny, reason-bound,
optionally time-bound, revocable without restart), suspension/lifecycle
restriction, and module-dependency safe-downgrade. It exposes one read-only,
fail-closed capability contract — `effective_entitlement` — that gates commercial
access on a different axis from RBAC/ABAC/RLS (a positive entitlement can never
grant a permission the actor lacks), and is the sole surface #872/#873/#875/#876
consume.

Admitted as an Official Optional Business Foundation, opt-in per tenant,
`defaultTenantState: "disabled"`. Every table is `tenant_id` + `ENABLE` +
`FORCE RLS` with a `tenant_id`-only policy (no soft super-tenant). Assign/
transition/override/revoke run a uniform concurrency pattern (row-lock or
`ON CONFLICT` + status-predicated update → clean 409, idempotency-replay wins a
same-key race), require `Idempotency-Key`, write an append-only evaluation
snapshot + emit a versioned domain event (same-commit, carrying the snapshot hash
for deterministic cache invalidation), and are audited. Immutability/write-once is
enforced by DB triggers; entitlement loss changes state + gates, never deleting
tenant data. Resolution is bounded (bulk query + in-memory, no per-request N+1
catalog query). Ships migrations 081/082, the `/api/v1/tenant-entitlement/*`
endpoints (OpenAPI), the two `awcms-mini.tenant-entitlement.*` events (AsyncAPI),
an admin explanation/override screen, and the `awcms-mini-tenant-entitlement`
skill.
