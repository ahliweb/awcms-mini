-- Issue #436 (M9 — Peningkatan kerasan backend & integrasi eksternal).
--
-- Adds a transient `sending` status to `awcms_mini_object_sync_queue` so the
-- new internal dispatcher (`src/modules/sync-storage/application/
-- object-dispatch.ts`) can safely CLAIM a batch of eligible rows inside one
-- short transaction (`UPDATE ... SET status = 'sending' ... FOR UPDATE SKIP
-- LOCKED`), then that short transaction ends and the object storage
-- provider is called OUTSIDE of any DB transaction (ADR-0006 — never call
-- a provider inside a transaction),
-- then finalize with a second short transaction that flips the row to
-- `sent`/`failed`/back to `pending` (backoff) depending on the outcome.
--
-- The claim reuses the existing `next_retry_at` column as a claim "lease
-- expiry" while status = 'sending' (no new column needed): if a dispatcher
-- process crashes between claim and finalize, the row is naturally
-- reclaimable by a later dispatch pass once its lease expires, via the same
-- `(tenant_id, status, next_retry_at)` index migration 017 already added.
ALTER TABLE awcms_mini_object_sync_queue
  DROP CONSTRAINT awcms_mini_object_sync_queue_status_check;

ALTER TABLE awcms_mini_object_sync_queue
  ADD CONSTRAINT awcms_mini_object_sync_queue_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed'));
