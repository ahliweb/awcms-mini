-- Issue #830 (epic #818 post-audit hardening) — Tier A missing indexes.
-- Pure DDL: no table/column/constraint/RLS change, no application code
-- change. Every index below is additive and `IF NOT EXISTS`, so this
-- migration is safe to apply to an already-populated database.
--
-- Two distinct rationales are mixed here; they are kept in one migration
-- because they share a single motivation (an index that should have
-- existed since the table was created) and none of them is hot enough on
-- its own to justify its own migration number:
--
--   (1) ORDER BY / predicate support for a real query in this repo —
--       verified with EXPLAIN (ANALYZE) against a 60k-row seed, not
--       assumed. See the per-index comments below.
--   (2) FK-check support: PostgreSQL does NOT auto-create an index on a
--       REFERENCING column. Without one, every DELETE/UPDATE of a
--       referenced parent row forces a full seq scan of the child table
--       to prove no child still points at it. The four columns in §3 are
--       FK columns with no covering index at all.
--
-- The three pure-FK-check indexes in §3 are deliberately NOT partial on
-- `IS NOT NULL`, unlike the read-path indexes in §1/§2. A referential-
-- integrity check is planned internally by PostgreSQL, not from this
-- repo's own SQL, so it is not worth betting the entire point of the
-- index on the planner proving that `col = $1` implies a partial index's
-- `col IS NOT NULL` predicate. NULL btree entries are cheap; the seq scan
-- this index exists to prevent is not.
--
-- Deliberately NOT included: the ~57 other FK columns that are already
-- covered as the NON-leading column of a `(tenant_id, x)` index. Those
-- are fine and must stay untouched — every query in this repo filters
-- `tenant_id` explicitly (doc 16 §tenant-scoped access), so the composite
-- already serves them, and an extra single-column index would be pure
-- write amplification with no read benefit.

-- ---------------------------------------------------------------------
-- 1. Blog admin list: ORDER BY updated_at DESC
-- ---------------------------------------------------------------------
-- `blog-post-directory.ts` (listBlogPostsForAdmin) and
-- `blog-page-directory.ts` (listBlogPagesForAdmin) both end in
-- `... WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY updated_at
-- DESC LIMIT $n OFFSET $m`. Migration 026 created neither table with any
-- `updated_at` index, so EVERY admin blog list page was a Seq Scan over
-- the tenant's entire post/page set followed by a top-N heapsort.
--
-- The index is partial on `deleted_at IS NULL` (matching the query's own
-- constant predicate) so that soft-deleted rows cost nothing to keep and
-- the index stays proportional to the live working set — the same shape
-- as `awcms_mini_blog_posts_slug_dedup` already uses on these tables.
CREATE INDEX IF NOT EXISTS awcms_mini_blog_posts_tenant_updated_idx
  ON awcms_mini_blog_posts (tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_blog_pages_tenant_updated_idx
  ON awcms_mini_blog_pages (tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- 2. Scheduled-publish job: WHERE status = 'scheduled' AND scheduled_at <= now()
-- ---------------------------------------------------------------------
-- `blog-scheduled-publish.ts` (publishDueScheduledPosts) runs
-- `WHERE tenant_id = $1 AND status = 'scheduled' AND scheduled_at IS NOT
-- NULL AND scheduled_at <= $2 AND deleted_at IS NULL FOR UPDATE` on a
-- timer, per tenant.
--
-- NOTE (corrects issue #830's premise): the existing
-- `(tenant_id, status, published_at DESC)` index is NOT useless here —
-- EXPLAIN confirms it is already picked as a Bitmap Index Scan on its two
-- leading columns. What it cannot do is apply the `scheduled_at <= now()`
-- bound, so it reads the heap for EVERY scheduled row of the tenant and
-- discards the not-yet-due ones. The partial index below carries
-- `scheduled_at` as an index column, so the time bound becomes an Index
-- Cond and the job touches only genuinely-due rows.
--
-- Partial on the job's own constant predicates (`status = 'scheduled'`,
-- `deleted_at IS NULL`): 'scheduled' is a transient state a post leaves
-- as soon as it publishes, so this index stays tiny — a rounding error
-- next to the full table — while `published`/`draft` rows, which are the
-- overwhelming majority and are never read by this job, cost nothing.
CREATE INDEX IF NOT EXISTS awcms_mini_blog_posts_scheduled_due_idx
  ON awcms_mini_blog_posts (tenant_id, scheduled_at)
  WHERE status = 'scheduled' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- 3. FK columns with no covering index at all
-- ---------------------------------------------------------------------
-- `awcms_mini_abac_decision_logs.tenant_user_id` -> awcms_mini_tenant_users
-- (migration 005). This is the fastest-growing table in the base: one
-- INSERT per ABAC decision, allow AND deny alike. Its only index is
-- `(tenant_id, created_at DESC)`, which cannot serve a FK check on
-- `tenant_user_id`, so revoking a tenant user's access (a DELETE of the
-- parent `awcms_mini_tenant_users` row) seq-scans the entire decision log.
CREATE INDEX IF NOT EXISTS awcms_mini_abac_decision_logs_tenant_user_idx
  ON awcms_mini_abac_decision_logs (tenant_user_id);

-- `awcms_mini_visitor_sessions.identity_id` -> awcms_mini_identities
-- (migration 039). High-volume table; its sibling `awcms_mini_visit_events`
-- already has `(identity_id, occurred_at DESC)` from the same migration —
-- the sessions table was simply missed.
CREATE INDEX IF NOT EXISTS awcms_mini_visitor_sessions_identity_idx
  ON awcms_mini_visitor_sessions (identity_id);

-- `awcms_mini_sync_outbox.node_id` -> awcms_mini_sync_nodes (migration 007).
-- The directly adjacent `awcms_mini_sync_inbox` in the SAME migration has
-- `awcms_mini_sync_inbox_tenant_node_idx`; the outbox never got the
-- equivalent. Node de-registration is the parent DELETE this protects.
CREATE INDEX IF NOT EXISTS awcms_mini_sync_outbox_node_idx
  ON awcms_mini_sync_outbox (node_id);

-- `awcms_mini_blog_ads.tenant_id` -> awcms_mini_tenants (migration 029).
-- Unlike the three above, this one is read-path relevant, not just
-- FK-check relevant: `ads-directory.ts`'s getAd/listAds/updateAd all
-- filter `tenant_id = $1`, and the RLS policy predicate is `tenant_id`
-- too — yet the table has no index whatsoever beyond its PK. Ordered by
-- `created_at DESC` to match listAds' own ORDER BY, and partial on
-- `deleted_at IS NULL` to match its soft-delete filter.
CREATE INDEX IF NOT EXISTS awcms_mini_blog_ads_tenant_created_idx
  ON awcms_mini_blog_ads (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;
