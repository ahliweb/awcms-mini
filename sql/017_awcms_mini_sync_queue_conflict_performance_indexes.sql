-- Issue #435 (M9 performance audit) — add composite indexes that were
-- measured (EXPLAIN ANALYZE, BUFFERS, ~200k-row seeded tenant) to be missing
-- for three real, currently-Seq-Scanning query shapes. All three tables
-- already have RLS + a tenant-prefixed index for their *other* query shapes
-- (migrations 008/009); this migration adds the ones that were never added
-- for the `ORDER BY created_at` listing shapes below — it does not replace
-- or drop any existing index.
--
-- 1. `GET /api/v1/sync/object-queue` (no `status` filter, admin/session-auth,
--    `src/modules/sync-storage/application/sync-directory.ts`
--    `fetchObjectQueueEntries`): `WHERE tenant_id ORDER BY created_at DESC
--    LIMIT 200` had no index covering `tenant_id` + `created_at`, so it ran a
--    Parallel Seq Scan over the whole table + a Sort (33.9ms measured against
--    200k seeded rows, `Buffers: shared hit=280 read=5008`).
-- 2. Same endpoint with a `status` filter: the existing
--    `awcms_mini_object_sync_queue_retry_idx (tenant_id, status,
--    next_retry_at)` matches the `tenant_id, status` prefix but not
--    `created_at`, so Postgres still did a Bitmap Heap Scan across every
--    matching row + a Sort (42.9ms measured, `Buffers: ... read=5318
--    written=2590`).
-- 3. `GET /api/v1/sync/objects/status` (HMAC node-auth polling endpoint —
--    the highest-QPS caller in an offline-first deployment, every sync node
--    polls this repeatedly): `WHERE tenant_id AND node_id AND status <>
--    'sent' ORDER BY created_at ASC LIMIT 100` had no index covering
--    `tenant_id, node_id`, so it ran a Parallel Seq Scan + Sort (27.7ms
--    measured). `status <> 'sent'` is a not-equal predicate — btree cannot
--    push it into the index condition — so the new index only needs to
--    cover `(tenant_id, node_id, created_at)`; the inequality remains a
--    cheap Filter over the now-node-scoped row set.
-- 4. `GET /api/v1/sync/conflicts` (no `status` filter,
--    `src/pages/api/v1/sync/conflicts/index.ts`): `WHERE tenant_id ORDER BY
--    created_at DESC LIMIT 50` had no index covering `tenant_id` +
--    `created_at` alone — the existing `awcms_mini_sync_conflicts_tenant_status_idx
--    (tenant_id, status, created_at DESC)` only helps once `status` is
--    filtered. Seq Scan measured at 30.1ms against 200k seeded rows.
--
-- Verified after this migration (same seeded data): all four query shapes
-- switch to an Index Scan / Index Only Scan on the new index, sub-millisecond
-- execution time. See PR description for full before/after EXPLAIN output.
CREATE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_tenant_created_idx
  ON awcms_mini_object_sync_queue (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_tenant_status_created_idx
  ON awcms_mini_object_sync_queue (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_object_sync_queue_tenant_node_created_idx
  ON awcms_mini_object_sync_queue (tenant_id, node_id, created_at);

CREATE INDEX IF NOT EXISTS awcms_mini_sync_conflicts_tenant_created_idx
  ON awcms_mini_sync_conflicts (tenant_id, created_at DESC);
