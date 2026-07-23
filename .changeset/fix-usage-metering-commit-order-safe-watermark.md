---
"awcms-mini": patch
---

usage_metering (#900): key the aggregation cursor on a **commit-ordered `xid8`**
safe-watermark instead of the INSERT-ordered `ingest_seq`, closing a
commit-reorder under-count hazard (a billing-input revenue leak). `ingest_seq`
(`nextval`) is drawn at INSERT time, not COMMIT, so a producer that drew a lower
seq could commit _after_ a higher one and slip under a strictly-ascending
`checkpoint_seq` — permanently under-counting its window when no later event
re-touched it and no reconciliation ran.

Migration `099_awcms_mini_usage_metering_safe_watermark_cursor.sql` adds
`ingest_xid8` (`pg_current_xact_id()`) to `awcms_mini_usage_events` /
`awcms_mini_usage_corrections`, a `checkpoint_xid8` floor to
`awcms_mini_usage_aggregation_cursors` (guarded monotonic-forward by an extended
immutability trigger), and drain-order indexes. The aggregation worker now
computes `safe = pg_snapshot_xmin(pg_current_snapshot())` once per pass and
drains only settled rows (`ingest_xid8 < safe`) from the floor upward, never
advancing into a truncated transaction — so a late-committing lower-order event
is structurally never skipped. `checkpoint_seq` is retained as an informational
high-water. Recompute-from-source and the REQUIRED scheduled reconciliation
remain as defence-in-depth backstops (unchanged). Adds a real-Postgres
commit-reorder regression test. Internal fix — no API/event change.
