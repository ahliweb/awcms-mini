-- Issue #900 (epic #868 SaaS control plane, module usage_metering #875,
-- follow-up from PR #899 review) — STRUCTURAL commit-order safe-watermark for
-- the aggregation cursor, closing the commit-reorder under-count hazard the
-- `sql/087` header + README documented as a deliberate follow-up.
--
-- ## The hazard (recap from sql/087 lines ~60-89)
--
-- `ingest_seq bigint DEFAULT nextval(...)` is drawn at INSERT time, NOT at
-- COMMIT. Two concurrent producers T1(seq=5) and T2(seq=6): if T2 commits
-- first, a strictly-ascending `checkpoint_seq` cursor can advance to 6; when T1
-- commits later (seq=5), the next batch `ingest_seq > 6` never sees seq=5. If
-- that event is the only one in its (meter, window) and no later event touches
-- the window and no reconciliation pass runs, the window is permanently
-- under-counted in `usage_aggregates` — a billing-input revenue leak. The two
-- backstops (recompute-from-source + REQUIRED scheduled reconciliation) remain
-- in place and UNCHANGED — this migration ADDS a structural guarantee so the
-- cursor never advances past an uncommitted lower-order row in the first place.
--
-- ## The fix — an xid8 commit-order watermark
--
-- COMMIT order — unlike `nextval` INSERT order — is exactly what a snapshot
-- captures. We stamp each event/correction with `ingest_xid8`
-- (`pg_current_xact_id()`, a wraparound-safe 64-bit FullTransactionId, PG 13+),
-- and the aggregation worker (application/aggregation-engine.ts) reads only rows
-- whose transaction is SETTLED: it computes `safe = pg_snapshot_xmin(
-- pg_current_snapshot())` once per pass and drains `ingest_xid8 < safe`. Every
-- xid8 below `safe` belongs to a transaction that is no longer in-progress
-- (committed or aborted), and — crucially — NO in-flight or future transaction
-- can ever have an xid8 below `safe` (xmin is by definition ≤ every running
-- xid). So a lower-xid8 producer that commits late is ALWAYS still ≥ the `safe`
-- boundary the cursor last advanced to, and is caught on the next pass. The
-- cursor floor becomes `checkpoint_xid8` (drained rows are `>= checkpoint_xid8
-- AND < safe`); the informational `checkpoint_seq` is kept but no longer drives
-- batching.
--
-- Head-of-line note: a long-running transaction holds `safe` back (it pins
-- xmin), so aggregation of newer committed rows waits behind it. That is
-- CONSERVATIVE and CORRECT (never an under-count), and the reconciliation
-- backstop still covers the window; it is an accepted trade-off.
--
-- ## Backfill of pre-existing rows (volatile default → table rewrite)
--
-- `DEFAULT pg_current_xact_id()` is volatile, so ADD COLUMN ... NOT NULL
-- rewrites both (new, low-volume) tables. Within this single migration
-- transaction the function is evaluated ONCE, so every pre-existing row gets
-- THIS migration's own xid8 — a settled value that will always sort below any
-- future `safe`, so historical rows are drained exactly once by the next pass
-- (recompute-from-source is idempotent — no double count). Acceptable given the
-- module's newness / low volume.
--
-- Least-privilege: no new grants. The app role already INSERTs events/
-- corrections (the DEFAULT calls the built-in `pg_current_xact_id()`, executable
-- by PUBLIC); the worker already holds SELECT on both source tables and UPDATE
-- on the cursor (table-level grants cover the new columns). RLS/tenant isolation
-- and the append-only/immutability triggers are untouched.

-- =====================================================================
-- 1. Stamp the immutable source rows with their COMMIT-ordered transaction id.
-- =====================================================================
ALTER TABLE awcms_mini_usage_events
  ADD COLUMN IF NOT EXISTS ingest_xid8 xid8 NOT NULL DEFAULT pg_current_xact_id();

ALTER TABLE awcms_mini_usage_corrections
  ADD COLUMN IF NOT EXISTS ingest_xid8 xid8 NOT NULL DEFAULT pg_current_xact_id();

-- Drain order: the worker scans per tenant in (commit-order xid8, ingest_seq)
-- order and range-filters on `ingest_xid8`. xid8 has btree comparison operators
-- (unlike xid), so this index serves both the `>= checkpoint_xid8 AND < safe`
-- range and the ORDER BY.
CREATE INDEX IF NOT EXISTS awcms_mini_usage_events_ingest_xid8_idx
  ON awcms_mini_usage_events (tenant_id, ingest_xid8, ingest_seq);

CREATE INDEX IF NOT EXISTS awcms_mini_usage_corrections_ingest_xid8_idx
  ON awcms_mini_usage_corrections (tenant_id, ingest_xid8, ingest_seq);

-- =====================================================================
-- 2. The cursor floor: a commit-order low-water the worker re-scans from.
--    `'1'::xid8` is the safe initial floor (below any real assigned xid8), so a
--    fresh cursor drains from the very first committed row. `checkpoint_seq` is
--    KEPT (informational high-water; sql/087's monotonic-forward trigger still
--    guards it) but no longer drives batching.
-- =====================================================================
ALTER TABLE awcms_mini_usage_aggregation_cursors
  ADD COLUMN IF NOT EXISTS checkpoint_xid8 xid8 NOT NULL DEFAULT '1'::xid8;

-- =====================================================================
-- 3. Extend the cursor immutability guard: `checkpoint_xid8` only advances
--    forward (monotonic), exactly like `checkpoint_seq`. A recompute-from-source
--    replay re-processes the same page and never double-counts, so re-scanning a
--    boundary xid8 is safe; REWINDING the floor is not (it could re-open a race).
-- =====================================================================
CREATE OR REPLACE FUNCTION awcms_mini_usage_guard_cursor_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.shard_key <> OLD.shard_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'usage_metering: cursor % identity is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.checkpoint_seq < OLD.checkpoint_seq THEN
    RAISE EXCEPTION 'usage_metering: cursor % checkpoint_seq is monotonic forward (a checkpoint is never rewound)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.checkpoint_xid8 < OLD.checkpoint_xid8 THEN
    RAISE EXCEPTION 'usage_metering: cursor % checkpoint_xid8 is monotonic forward (the commit-order safe-watermark floor is never rewound)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
