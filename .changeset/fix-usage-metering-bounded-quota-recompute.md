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
  assumed `0`.
- The **open tail** is always recomputed live from source (one bounded read), so
  a late event in the hot period counts immediately.
- `unique_count` stays a full source recompute (distinct sets across sub-windows
  overlap and cannot be summed).
- A `QUOTA_MAX_SOURCE_ROWS` (100 000) budget caps every source read via a
  `LIMIT budget+1` tripwire — exceeding it fails closed (`usage_unavailable` →
  a hard quota denies) rather than running an unbounded scan; it is never
  silently truncated.

Internal only — no API/response-shape, migration, or event change (the settled
lookup rides the existing `awcms_mini_usage_aggregates_lookup_idx`). Tenant
isolation (RLS) and determinism are preserved.
