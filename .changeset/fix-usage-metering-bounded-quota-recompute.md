---
"awcms-mini": patch
---

Performance (usage_metering, Issue #901): the fail-closed quota decision no
longer does an unbounded live recompute of the whole reset window on every
call. `getQuotaDecision` previously read every event + correction whose
`event_time` fell in the reset window and summed them in memory — for a
`monthly` reset on a high-volume meter that is `O(events-per-month)` per quota
check.

The recompute is now **bounded by decomposition** into one-calendar-level-finer
sub-windows (`month`→`day`, `day`→`hour`), still fail-closed and still never
over-admitting a hard quota:

- The **settled** prefix (`sub_end + 1h grace ≤ now`) is served from the
  worker's indexed materialized sub-aggregates — `O(sub-windows)` (≤ 31 day
  rows), never `O(events)`. A settled sub-window whose aggregate is **missing**
  (worker lag) is recomputed from source bounded to that one sub-window, never
  assumed `0`. A settled sub-aggregate that is **present but stale** — a
  late-beyond-grace event/correction landed in its window with an `ingest_seq`
  above the aggregate's folded `source_watermark` and the worker has not
  re-folded it — is detected by one **index-only** existence probe over the
  settled prefix and recomputed from source too (the healthy path finds nothing
  → zero extra source reads). Without this a hard quota could transiently
  OVER-ADMIT past its limit on worker lag.
- The **open tail** is always recomputed live from source (one bounded read), so
  a late event in the hot period counts immediately.
- `unique_count` stays a full source recompute (distinct sets across sub-windows
  overlap and cannot be summed).
- A `QUOTA_MAX_SOURCE_ROWS` (100 000) budget caps every source read via a
  `LIMIT budget+1` tripwire — exceeding it fails closed (`usage_unavailable` →
  a hard quota denies) rather than running an unbounded scan; it is never
  silently truncated.

One index-only migration (sql/100) extends the usage-events/corrections
`..._window_idx` with `ingest_seq` so the staleness probe is served straight
from the index (an `Index Only Scan`, no heap fetch); it replaces the 3-column
window index (a strict superset) rather than adding a redundant one. No
API/response-shape or event change; tenant isolation (RLS) and determinism
preserved.
