---
"awcms-mini": minor
---

feat(payment-gateway): make the outbound command queue purgeable (#930)

Issue #932 made the webhook EVIDENCE chain purgeable and left the outbox
behind, with the same defect in a purer form. `awcms_mini_payment_gateway_outbox`
had a `BEFORE DELETE` trigger that raised unconditionally — so no role could
delete a row, not the app role, not the worker, not even the migration owner —
plus no `DELETE` grant anywhere, and no `DELETE` statement anywhere in `src/`
or `scripts/`. It grew without bound, forever.

It is not a small table. One row per outbound provider command
(`create_checkout`, `request_refund`, `query_status`, `cancel_session`) with a
`payload jsonb` of up to 8000 characters, and `query_status` polls — the
highest-volume write path in the module. #930's Wave 5 named it explicitly.

Migration 106 drops the trigger rather than narrowing it: unlike #932's
tables it guarded only DELETE, so there was nothing left to narrow to. The
boundary moves to grants, exactly where #932 put it — `awcms_mini_app` is
explicitly revoked and keeps `SELECT, UPDATE` only, so a request handler still
cannot delete a queued command whatever SQL it issues, and the worker's new
`DELETE` makes the retention purge the single real delete path and therefore
the single enforcement point for legal hold.

**Two predicates, and the status one is the load-bearing half.** A command
that has not reached a terminal state is work that still owes a customer
something: deleting a `pending`/`in_flight`/`failed` row would silently drop a
checkout, refund, or cancellation, with the retry loop simply never seeing it
again and no error anywhere. `failed` is protected despite the name — it is
retryable and shares the due index with `pending`. The retention index is
PARTIAL on `status IN ('succeeded','dead')` so the safe predicate is also the
fast one: a purge that forgot the status filter would be wrong *and* slow
rather than quietly wrong.

The cursor is `updated_at`, not `created_at` like every other descriptor in
this module. A command queued three months ago that only reached `dead` today
has been finished for zero days; ageing on `created_at` would purge it
immediately.

The outbox is legal-held independently of both the evidence chain and the
reconciliation log — the chain is what a provider told us, the outbox is what
we asked a provider to do, and neither references the other.

Both non-obvious decisions are mutation-verified: removing the status filter
fails "a LIVE command is never eligible", and switching the cursor to
`created_at` fails "age is measured from when the command stopped being live".
The `IN (SELECT … LIMIT n)` batching was also verified to genuinely bound a
DELETE on this schema (10 candidates, limit 2, exactly 2 deleted) — with a
comment warning against "improving" it with `FOR UPDATE SKIP LOCKED`, which
would push the LIMIT onto a semi-join's inner side and silently unbound the
batch, the exact regression that forced a MATERIALIZED CTE in the entitlement
expiry sweep.
