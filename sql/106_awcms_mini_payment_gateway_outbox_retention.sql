-- Issue #930 (epic #868) Wave 5 — make the payment-gateway OUTBOX purgeable.
--
-- ## The gap
--
-- Issue #932 (migration 102) made the webhook EVIDENCE chain purgeable:
-- `webhook_inbox <- normalized_events <- processing_attempts`, plus
-- `reconciliations`. It narrowed their `BEFORE UPDATE OR DELETE` triggers to
-- `BEFORE UPDATE` and moved the delete boundary to grants.
--
-- The outbox was not part of that change, and it has the same defect in a
-- purer form: `awcms_mini_payment_gateway_outbox_no_delete` is a
-- `BEFORE DELETE` trigger that raises unconditionally, so NO role can delete a
-- row — not the app role, not the worker, not even the migration owner. There
-- is also no `DELETE` grant anywhere and no DELETE statement anywhere in
-- `src/` or `scripts/`. The table therefore grows without bound, forever.
--
-- That is not a small table. It holds one row per outbound provider command
-- (`create_checkout`, `request_refund`, `query_status`, `cancel_session`) with
-- a `payload jsonb` of up to 8000 characters — the highest-volume write path
-- in the module, since `query_status` polls.
--
-- #930's Wave 5 named exactly this ("plus the outbox/normalized-event/
-- processing-attempt tables ... if their growth warrants it"). The other two
-- were registered by #932; this closes the outbox.
--
-- ## Why the trigger is DROPPED rather than narrowed
--
-- Migration 102 narrowed its triggers because they guarded UPDATE as well, and
-- the in-place-edit protection had to survive. This trigger guards ONLY
-- DELETE, so there is nothing left to narrow to — the whole trigger is the
-- delete prohibition.
--
-- Dropping it does not open a hole, because the delete boundary moves to the
-- same place #932 put it: GRANTS. `awcms_mini_app` (the request path) holds
-- `SELECT, UPDATE` only and is explicitly revoked below, so a request handler
-- still cannot delete a queued command no matter what SQL it issues. Only the
-- unattended worker can, which makes the retention purge the single real
-- delete path — and therefore the single place where "a legal hold overrides
-- ordinary retention" has to be enforced.
--
-- ## What must never be purgeable, and why the index encodes it
--
-- A command that has not reached a terminal state is WORK THAT STILL OWES A
-- CUSTOMER SOMETHING. Deleting a `pending`/`in_flight`/`failed` row would
-- silently drop a checkout, a refund, or a cancellation — the retry loop would
-- simply never see it again, with no error anywhere. Only `succeeded` and
-- `dead` are terminal:
--
--   * `pending`   — queued, not yet attempted.
--   * `in_flight` — claimed by a dispatcher right now.
--   * `failed`    — RETRYABLE. It sits in the due index alongside `pending`
--                   and will be attempted again; the name is misleading.
--   * `succeeded` — done.
--   * `dead`      — attempts exhausted. Terminal, and the row an operator most
--                   wants to still be able to read, which is why retention is
--                   measured in months rather than days.
--
-- The retention index below is PARTIAL on exactly those two statuses. That is
-- deliberate: it makes the safe predicate the fast one, so a future purge that
-- forgot the status filter would be both wrong AND slow, rather than quietly
-- wrong.
--
-- ## Cursor column is `updated_at`, not `created_at`
--
-- Every other retention descriptor in this module ages on creation. This one
-- must not: a command created three months ago that only reached `dead` today
-- has been finished for zero days. `updated_at` is the moment it reached its
-- terminal state, so the retention window means what it says — "how long since
-- this command stopped being live" — rather than "how long since it was
-- queued".

-- 1. Remove the blanket delete prohibition. The boundary moves to grants (2).
DROP TRIGGER IF EXISTS awcms_mini_payment_gateway_outbox_no_delete
  ON awcms_mini_payment_gateway_outbox;

-- 2. Grants. Re-asserted for the request-path role rather than newly granted:
-- migration 093 never gave it DELETE, and this makes that explicit and
-- durable now that the trigger no longer backstops it.
REVOKE DELETE ON awcms_mini_payment_gateway_outbox FROM awcms_mini_app;

-- The worker already holds SELECT, UPDATE (migration 093, for the dispatcher).
-- Only DELETE is added.
GRANT DELETE ON awcms_mini_payment_gateway_outbox TO awcms_mini_worker;

-- 3. Retention-scan index — age-ordered per tenant, partial on the terminal
-- statuses only (see header).
CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_outbox_retention_idx
  ON awcms_mini_payment_gateway_outbox (tenant_id, updated_at)
  WHERE status IN ('succeeded', 'dead');
