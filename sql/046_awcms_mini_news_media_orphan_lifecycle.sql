-- Issue #690 (epic #679, platform-hardening — "runtime/worker hardening"
-- wave). Adds `orphaned_at` to `awcms_mini_news_media_objects` so the new
-- pending/orphan R2 lifecycle cleanup & reconciliation job
-- (`scripts/news-media-r2-reconcile.ts`, `bun run news-media:reconcile`) can
-- measure the `r2-backup-lifecycle.md` §3 orphan grace period
-- (`NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS`, default 30 days) from the EXACT moment
-- a row transitioned to `status = 'orphaned'` — not from `updated_at`, which
-- is touched by every column update this table supports and would silently
-- and incorrectly reset/extend the grace period window if any future change
-- ever updates an orphaned row for an unrelated reason.
--
-- `markNewsMediaObjectOrphaned` (`news-media-object-directory.ts`, migration
-- 041) already existed as a "flag for cleanup" transition before this
-- migration, but nothing in the codebase called it yet (no orphan-detection
-- job existed) — this migration/issue does not add that detection (cross-
-- referencing `blog_content` surfaces for "no longer referenced" is
-- explicitly deferred, `r2-backup-lifecycle.md` §4: "Implementasi konkret...
-- di luar cakupan Issue #631"). This migration only adds the timestamp
-- column so that WHENEVER a future issue starts calling
-- `markNewsMediaObjectOrphaned`, the grace-period sweep implemented here
-- already works correctly from day one.
--
-- `orphaned_at` is deliberately NOT required to move in lockstep with
-- `deleted_at` (soft delete stays orthogonal to `status`, same convention as
-- every other column on this table since migration 041) — a row can be
-- `status = 'orphaned'` with `orphaned_at` set, then later soft-deleted by
-- this same reconciliation job once its grace period elapses (`deleted_at`
-- gets set at that point, `orphaned_at`/`status` do not change again).
--
-- CHECK constraint mirrors the existing
-- `awcms_mini_news_media_objects_owner_consistency_check` idiom (migration
-- 041): a column that only has meaning for one specific `status` value is
-- constrained to be non-null exactly when that status holds, and null
-- otherwise — so a bug that sets `orphaned_at` on a non-orphaned row (or
-- forgets to set it when transitioning TO orphaned) is rejected by Postgres
-- itself, not just by application-layer discipline.

ALTER TABLE awcms_mini_news_media_objects
  ADD COLUMN IF NOT EXISTS orphaned_at timestamptz;

ALTER TABLE awcms_mini_news_media_objects
  ADD CONSTRAINT awcms_mini_news_media_objects_orphaned_at_consistency_check
  CHECK (
    (status = 'orphaned' AND orphaned_at IS NOT NULL)
    OR
    (status <> 'orphaned' AND orphaned_at IS NULL)
  );

-- `awcms_mini_worker` least-privilege role (migration 045) — extends its
-- grant matrix with the 8th unattended cron-style script
-- (`bun run news-media:reconcile`, Issue #690). Needs SELECT (the
-- reconciliation snapshot query), UPDATE (claiming pending_upload/uploaded
-- rows to `failed`, soft-deleting stale `orphaned` rows), and DELETE (hard-
-- deleting expired `failed` rows) — exactly the DML
-- `news-media-reconciliation.ts`/`news-media-object-directory.ts` issue —
-- zero access to any of the 9 global tables, same pattern every other
-- worker grant in migration 045 already follows. `awcms_mini_audit_events`
-- (INSERT, for this job's own audit events) is already granted (migration
-- 045) — not repeated here.
GRANT SELECT, UPDATE, DELETE ON awcms_mini_news_media_objects TO awcms_mini_worker;

-- Sweep query shape: `WHERE tenant_id = $1 AND status = 'orphaned' AND
-- deleted_at IS NULL AND orphaned_at < $cutoff` — already covered by the
-- existing `idx_awcms_mini_news_media_objects_tenant_status` partial index
-- (migration 041, `(tenant_id, status) WHERE deleted_at IS NULL`) for the
-- `tenant_id`/`status` prefix; a dedicated `orphaned_at` index is not added
-- here because the `status = 'orphaned'` filter is already expected to be
-- highly selective (in practice a small minority of rows), matching the
-- reasoning `idx_awcms_mini_news_media_objects_tenant_status` itself already
-- documents for the `status` column generally.
