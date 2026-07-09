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
request_scope, idempotency_key) DO NOTHING RETURNING id`. On losing the
race, it re-`SELECT`s the now-committed winning row (guaranteed visible,
since `ON CONFLICT` only fires against an already-committed row under
READ COMMITTED — a still-uncommitted conflicting insert would have
blocked instead) and compares its `request_hash`: identical payload ->
throws a new `IdempotencyRaceLostError` carrying the winner's response to
replay, honoring the pre-existing "hash sama -> replay" rule even under
the race; different payload -> throws it with no replay (a genuine
conflict). `withTenant` (`src/lib/database/tenant-context.ts`) — the
single chokepoint every existing endpoint already calls — catches this
error: rolls back the loser's transaction (so its mutation never
persists), skips the circuit breaker (benign concurrency outcome, not an
infra failure), logs `idempotency.race_lost` (a SHA-256 hash of the key,
never the raw value, per doc 10 masking discipline), and returns either
the replayed response or a clean `409 IDEMPOTENCY_CONFLICT`. This applies
automatically to every idempotent endpoint in the repo (POS-style
posting, blog lifecycle actions, workflow decisions, tenant domain
`verify`/`set-primary`, email announcements, form-draft submit, etc.)
without touching any of the individual route files.

New regression tests in
`tests/integration/tenant-domain-api.integration.test.ts`: "set-primary
under concurrent SAME Idempotency-Key + SAME payload" fires two parallel
requests with an identical key and identical target against the real
database and asserts both get 200 (the winner's mutation and the loser's
transparent replay), exactly one audit event, and exactly one persisted
idempotency key row; "verify under concurrent SAME Idempotency-Key +
DIFFERENT payload" (using two different domains, deliberately avoiding
`set-primary`'s own unrelated primary-dedup race) asserts exactly one 200
and one clean `409 IDEMPOTENCY_CONFLICT` — never two 200s, never a 500.
