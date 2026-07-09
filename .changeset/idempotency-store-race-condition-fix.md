---
"awcms-mini": patch
---

Fix a pre-existing race condition in the shared idempotency store
(`src/modules/_shared/idempotency.ts`): two concurrent requests with the
same `Idempotency-Key` (e.g. a client network retry racing its original
request) could both pass `findIdempotencyRecord` under READ COMMITTED
before either committed, and the loser's `saveIdempotencyRecord` insert
then failed on the `awcms_mini_idempotency_keys_scope_key` unique index
uncaught — surfacing as a raw constraint error / 500 and incorrectly
tripping the database circuit breaker, instead of the documented
"double submit paralel -> tidak dobel" guarantee (skill
`awcms-mini-idempotency`).

`saveIdempotencyRecord` now uses `INSERT ... ON CONFLICT (tenant_id,
request_scope, idempotency_key) DO NOTHING RETURNING id` and throws a new
`IdempotencyRaceLostError` when it loses the race. `withTenant`
(`src/lib/database/tenant-context.ts`) — the single chokepoint every
existing endpoint already calls — catches this error, rolls back the
loser's transaction (so its mutation never persists), skips the circuit
breaker (this is a benign concurrency outcome, not an infra failure), and
returns a clean `409 IDEMPOTENCY_CONFLICT`. This applies automatically to
every idempotent endpoint in the repo (POS-style posting, blog lifecycle
actions, workflow decisions, tenant domain `verify`/`set-primary`, email
announcements, form-draft submit, etc.) without touching any of the
individual route files.

New regression test:
`tests/integration/tenant-domain-api.integration.test.ts`'s "set-primary
under concurrent SAME Idempotency-Key" exercises two parallel requests
with an identical key against the real database and asserts exactly one
200/409 pair (never two 200s or a 500), exactly one audit event, and
exactly one persisted idempotency key row.
