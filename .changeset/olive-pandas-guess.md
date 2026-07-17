---
"awcms-mini": patch
---

perf(db): add missing indexes for blog admin lists, the scheduled-publish job, and four unindexed FK columns (Issue #830)

Migration `077_awcms_mini_performance_missing_indexes.sql` — pure DDL, no
application code change.

- `awcms_mini_blog_posts (tenant_id, updated_at DESC) WHERE deleted_at IS NULL`
  and the same on `awcms_mini_blog_pages`. Both admin list screens end in
  `ORDER BY updated_at DESC` but migration 026 created no `updated_at` index at
  all, so every page load was a Seq Scan of the tenant's whole post/page set
  plus a top-N heapsort. Measured on a 60k-row seed: root plan cost 3835 -> 2.9,
  execution 19.9ms -> 0.07ms, buffers 1655 -> 23.
- `awcms_mini_blog_posts (tenant_id, scheduled_at) WHERE status = 'scheduled' AND deleted_at IS NULL`
  for the periodic scheduled-publish job. The existing
  `(tenant_id, status, published_at DESC)` index was already being used, but it
  cannot apply the `scheduled_at <= now()` bound, so the job read the heap for
  every scheduled post and discarded the not-yet-due ones; work grew with the
  future-scheduled backlog rather than with the number of due posts.
- Indexes on four FK columns that had no covering index at all, so a parent
  DELETE forced a full child seq scan: `awcms_mini_abac_decision_logs.tenant_user_id`,
  `awcms_mini_visitor_sessions.identity_id`, `awcms_mini_sync_outbox.node_id`
  (its sibling `sync_inbox` already had the equivalent), and
  `awcms_mini_blog_ads.tenant_id` (also read-path: every `ads-directory.ts`
  query and the RLS policy filter on it, on a table with no index beyond its PK).
