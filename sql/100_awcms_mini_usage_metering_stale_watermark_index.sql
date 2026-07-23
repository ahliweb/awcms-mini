-- Issue #901 (epic #868 SaaS control plane, module usage_metering #875,
-- follow-up from PR #924 review M1) — make the bounded quota recompute's
-- SETTLED-sub-aggregate STALENESS probe cheap and robust.
--
-- ## Why
--
-- The bounded quota recompute (`quota-usage-recompute.ts`) trusts a settled
-- sub-window's materialized aggregate only if no source row has arrived in that
-- window SINCE it was materialized — otherwise (worker lag on a late-beyond-grace
-- arrival) the stored value UNDER-counts and a hard quota could OVER-ADMIT. It
-- detects this per settled window with a correlated existence probe:
--   EXISTS (... WHERE event_time >= window_start AND event_time < window_end
--                 AND ingest_seq > aggregate.source_watermark)
-- on `awcms_mini_usage_events` and `awcms_mini_usage_corrections`.
--
-- The existing window index `(tenant_id, meter_key, event_time)` cannot answer
-- that probe from the index alone — `ingest_seq` is not indexed there, so the
-- planner heap-fetches every event in the window to compare `ingest_seq` (an
-- O(events-per-settled-prefix) heap scan per quota check, re-introducing the
-- sql/901 hazard). Appending `ingest_seq` to the index makes the probe an
-- INDEX-ONLY correlated scan (verified by EXPLAIN: `Index Only Scan`,
-- `Heap Fetches: 0`), so the healthy path (no newer row) is confirmed straight
-- from the index.
--
-- ## What
--
-- REPLACE the 3-column window indexes with 4-column `(tenant_id, meter_key,
-- event_time, ingest_seq)` supersets. The superset serves every existing
-- event-time range read (recompute-from-source, reconciliation) identically, so
-- keeping the old 3-column index alongside would only add dead write amplification
-- on the high-volume append path — hence a REPLACE, not an ADD. Index-only
-- (no data column added), no RLS/permission/table-shape change.

DROP INDEX IF EXISTS awcms_mini_usage_events_window_idx;
CREATE INDEX IF NOT EXISTS awcms_mini_usage_events_window_idx
  ON awcms_mini_usage_events (tenant_id, meter_key, event_time, ingest_seq);

DROP INDEX IF EXISTS awcms_mini_usage_corrections_window_idx;
CREATE INDEX IF NOT EXISTS awcms_mini_usage_corrections_window_idx
  ON awcms_mini_usage_corrections (tenant_id, meter_key, event_time, ingest_seq);
