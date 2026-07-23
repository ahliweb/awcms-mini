/**
 * Bounded authoritative quota usage (Issue #901, epic #868, ADR-0022 §4).
 *
 * WHY. The quota decision must be AUTHORITATIVE — it can never trust a possibly-
 * stale materialized aggregate to enforce a hard quota, or a lagging aggregation
 * worker would let it OVER-ADMIT. The first cut recomputed the ENTIRE reset
 * window LIVE from the immutable events on every call (`readWindowSources` with
 * no bound): correct, but O(events-per-reset-window). For a `monthly` reset on a
 * high-volume meter that is O(events-per-month) PER quota check — an unbounded
 * live recompute (the sql/901 perf hazard).
 *
 * FIX — bounded recompute by one-level-finer DECOMPOSITION, still fail-closed:
 *   - The reset window is split into sub-windows one calendar level finer
 *     (`month` -> `day`, `day` -> `hour`; an `hour` reset is already small and is
 *     recomputed whole).
 *   - SETTLED prefix (`sub_end + grace <= now`, so no in-grace late event can
 *     still land): read the worker's MATERIALIZED sub-aggregates — indexed,
 *     O(sub-windows) (<= 31 day rows for a month), never O(events). A settled
 *     sub-window MISSING its aggregate (worker lag) is NOT assumed 0 (that would
 *     under-count -> over-admit); it is recomputed from source, bounded to that
 *     one sub-window (or fails closed if it alone blows the budget). A settled
 *     sub-aggregate that is PRESENT but STALE — a late-beyond-grace event or
 *     correction landed in its window with an `ingest_seq` above the aggregate's
 *     folded `source_watermark`, which the worker has not yet re-folded — is
 *     detected by one BATCHED index-only existence query over the whole settled
 *     prefix and treated like a MISSING one (recomputed from source). The
 *     healthy path (no newer row) returns nothing, so it adds ZERO extra source
 *     reads. Aggregates whose stored aggregation/value_type no longer match the
 *     meter descriptor are likewise treated as missing (descriptor-drift guard).
 *   - OPEN tail (`sub_end + grace > now` — can still receive late events,
 *     including the current sub-window): ALWAYS recomputed LIVE from source (a
 *     single bounded read over the contiguous open suffix). This keeps the
 *     "worker lag can never over-admit" invariant for the hot period.
 *   - `unique_count` CANNOT be decomposed (distinct sets across sub-windows
 *     overlap, so summing sub-counts double-counts) -> it is FULL-recomputed
 *     from source, under the same row budget. HLL-style sketches are out of scope.
 *
 * ROW BUDGET (sql/901 "query-plan/row budget"): every source read is capped at
 * `QUOTA_MAX_SOURCE_ROWS` TOTAL (open tail + any settled-missing fallback + a
 * full `unique_count`). The cap is enforced with a `LIMIT budget+1` tripwire and
 * NEVER a silent truncation (truncation under-counts). Exceeding it throws
 * `QuotaSourceBudgetExceededError` -> the adapter maps it to
 * `freshness: "unavailable"` -> `decideQuota` makes a HARD quota DENY (fail
 * closed). Reconciliation + the #900 commit-order worker cursor remain the
 * defence-in-depth backstop for the ONE residual the inline probe cannot see (a
 * lower-`ingest_seq` row that commits after materialization); every other stale
 * case is detected and recomputed inline (see above).
 *
 * SECURITY INVARIANT (adversarially tested): except when it fails closed (budget
 * exceeded or a query error -> a hard quota DENIES) or during the transient
 * commit-reorder window the worker/reconciliation close, usage returned here is
 * NEVER lower than the true committed usage — a missing OR stale settled
 * sub-aggregate falls back to a bounded live recompute, and the open tail is
 * always live. So a lagging worker (including a late-beyond-grace arrival in a
 * settled window) can never let a hard quota over-admit. All reads run inside the
 * caller's tenant-scoped `tx` (RLS = the acting tenant): no cross-tenant read.
 * Deterministic — the value depends on event_time + quantity, never receive
 * order.
 */
import { AGGREGATION_LATENESS_GRACE_MS } from "./aggregation-engine";
import {
  computeWindowAggregate,
  windowEndFor,
  windowStartFor,
  type MeterAggregation,
  type MeterValueType,
  type WindowType
} from "../domain/meter-semantics";
import { readWindowSourcesBounded } from "./usage-source-query";

/**
 * The maximum number of immutable source rows a single quota recompute may read
 * across its open tail + settled-missing fallbacks (+ a full `unique_count`).
 * Beyond this the decision fails closed (a hard quota denies) rather than run an
 * unbounded scan. The settled prefix does not count against it — it is served
 * from indexed materialized sub-aggregates.
 */
export const QUOTA_MAX_SOURCE_ROWS = 100_000;

/** Thrown when a bounded recompute would read more than `QUOTA_MAX_SOURCE_ROWS`. */
export class QuotaSourceBudgetExceededError extends Error {
  constructor(public readonly budget: number) {
    super(`quota recompute exceeded the source row budget (${budget})`);
    this.name = "QuotaSourceBudgetExceededError";
  }
}

/** The one-calendar-level-finer sub-window a reset window decomposes into, or `null` if already smallest. */
export function subWindowTypeFor(resetWindow: WindowType): WindowType | null {
  switch (resetWindow) {
    case "month":
      return "day";
    case "day":
      return "hour";
    case "hour":
      return null;
  }
}

type StoredSubAggregateRow = {
  window_start: Date;
  aggregate_value: number | string;
  event_count: number | string;
  last_event_time: Date | null;
};

/** One sub-window's contribution to the reset-window aggregate. */
type Contribution = {
  value: number;
  /** `true` only when the sub-window actually held events (max/last skip empties). */
  hasEvents: boolean;
  /** The sub-window's latest event_time (for `last`); `null` when empty. */
  lastEventTime: Date | null;
};

/**
 * Compute the reset window's AUTHORITATIVE usage in a BOUNDED way. Throws
 * `QuotaSourceBudgetExceededError` when the row budget is exceeded (the adapter
 * fails closed). `[start, end)` is the reset window (`windowBoundsFor`); `now`
 * classifies settled vs open.
 */
export async function computeBoundedQuotaUsage(
  tx: Bun.SQL,
  tenantId: string,
  meterKey: string,
  aggregation: MeterAggregation,
  valueType: MeterValueType,
  resetWindow: WindowType,
  start: Date,
  end: Date,
  now: Date,
  opts?: { maxSourceRows?: number; graceMs?: number }
): Promise<number> {
  const budget = opts?.maxSourceRows ?? QUOTA_MAX_SOURCE_ROWS;
  const graceMs = opts?.graceMs ?? AGGREGATION_LATENESS_GRACE_MS;
  let remaining = budget;

  /** Bounded source read that debits the shared budget; fails closed on overflow. */
  async function readSource(
    s: Date,
    e: Date
  ): Promise<{
    value: number;
    hasEvents: boolean;
    lastEventTime: Date | null;
  }> {
    const src = await readWindowSourcesBounded(
      tx,
      tenantId,
      meterKey,
      s,
      e,
      null,
      remaining
    );
    if (src.overBudget) {
      throw new QuotaSourceBudgetExceededError(budget);
    }
    remaining -= src.events.length + src.corrections.length;
    const agg = computeWindowAggregate(
      aggregation,
      valueType,
      src.events,
      src.corrections
    );
    return {
      value: agg.value,
      hasEvents: src.events.length > 0,
      lastEventTime: agg.lastEventTime
    };
  }

  const subType = subWindowTypeFor(resetWindow);

  // unique_count is not decomposable (overlapping distinct sets); an already-
  // small `hour` reset needs no decomposition. Both full-recompute from source
  // under the row budget.
  if (aggregation === "unique_count" || subType === null) {
    return (await readSource(start, end)).value;
  }

  // The settled/open split point: the sub-window boundary at `now - grace`.
  // Sub-windows ending at or before it are SETTLED; the contiguous suffix is OPEN.
  const boundary = new Date(now.getTime() - graceMs);
  let settledEnd = windowStartFor(subType, boundary);
  if (settledEnd < start) settledEnd = start; // whole reset window is still open
  if (settledEnd > end) settledEnd = end; // whole reset window is settled

  const contributions: Contribution[] = [];

  // SETTLED prefix — one indexed lookup of the materialized sub-aggregates.
  if (settledEnd > start) {
    // Only aggregates computed under the meter's CURRENT semantics are trusted
    // (L1 descriptor-drift guard): a row whose stored `aggregation`/`value_type`
    // no longer matches the descriptor is treated as MISSING -> recomputed from
    // source, so a post-materialization descriptor change can never surface a
    // value under stale semantics.
    const rows = (await tx`
      SELECT window_start, aggregate_value, event_count, last_event_time
      FROM awcms_mini_usage_aggregates
      WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
        AND window_type = ${subType}
        AND aggregation = ${aggregation} AND value_type = ${valueType}
        AND window_start >= ${start} AND window_start < ${settledEnd}
    `) as StoredSubAggregateRow[];
    const byStart = new Map<number, Contribution>();
    for (const row of rows) {
      byStart.set(row.window_start.getTime(), {
        value: Number(row.aggregate_value),
        // An aggregate row exists only because an event touched the window.
        hasEvents: Number(row.event_count) > 0,
        lastEventTime: row.last_event_time
      });
    }

    // M1 over-admit guard: a settled sub-aggregate is trusted ONLY if no source
    // row has arrived in its window SINCE it was materialized. The aggregate's
    // `source_watermark` is the max `ingest_seq` folded into it (monotonic, DB-
    // enforced); a later event/correction lands with a strictly higher
    // `ingest_seq`. A late-beyond-grace row in an already-settled window that the
    // worker has not yet re-folded would make the stored value UNDER-count -> a
    // hard quota could ALLOW past its limit. One BATCHED existence query over the
    // whole settled prefix flags every such stale sub-window as an INDEX-ONLY
    // correlated scan on `..._window_idx (tenant_id, meter_key, event_time,
    // ingest_seq)`; the healthy path (no newer row) returns EMPTY and reads no
    // source rows into the recompute. A flagged sub-window is treated like a
    // MISSING one — recomputed from source, bounded, under the shared budget.
    // (A `received_at`-vs-`computed_at` predicate is equivalent in detection but
    // needs a heap fetch per row and a fragile join plan — measured far more
    // expensive; see the PR EXPLAIN.) The residual commit-reorder case — a
    // LOWER-`ingest_seq` row that COMMITS after materialization, which neither an
    // `ingest_seq` nor a `received_at` probe can see (sql/087 note) — is the
    // aggregation worker's job: its #900 commit-order (`xid8`) cursor re-folds it
    // and reconciliation flags any residual drift.
    const staleRows = (await tx`
      SELECT a.window_start
      FROM awcms_mini_usage_aggregates a
      WHERE a.tenant_id = ${tenantId} AND a.meter_key = ${meterKey}
        AND a.window_type = ${subType}
        AND a.window_start >= ${start} AND a.window_start < ${settledEnd}
        AND (
          EXISTS (
            SELECT 1 FROM awcms_mini_usage_events e
            WHERE e.tenant_id = a.tenant_id AND e.meter_key = a.meter_key
              AND e.event_time >= a.window_start AND e.event_time < a.window_end
              AND e.ingest_seq > a.source_watermark
          )
          OR EXISTS (
            SELECT 1 FROM awcms_mini_usage_corrections c
            WHERE c.tenant_id = a.tenant_id AND c.meter_key = a.meter_key
              AND c.event_time >= a.window_start AND c.event_time < a.window_end
              AND c.ingest_seq > a.source_watermark
          )
        )
    `) as { window_start: Date }[];
    const stale = new Set<number>();
    for (const row of staleRows) stale.add(row.window_start.getTime());

    // Walk every settled sub-window; a MISSING or STALE one is recomputed from
    // source (bounded to that one sub-window) — never assumed 0 or trusted
    // stale (either would over-admit).
    for (
      let subStart = start;
      subStart < settledEnd;
      subStart = windowEndFor(subType, subStart)
    ) {
      const hit = byStart.get(subStart.getTime());
      if (hit && !stale.has(subStart.getTime())) {
        contributions.push(hit);
      } else {
        contributions.push(
          await readSource(subStart, windowEndFor(subType, subStart))
        );
      }
    }
  }

  // OPEN tail — one bounded live read over the contiguous open suffix.
  if (settledEnd < end) {
    contributions.push(await readSource(settledEnd, end));
  }

  return combine(aggregation, contributions);
}

/** Merge sub-window contributions per aggregation (see meter-semantics for the invariants). */
function combine(
  aggregation: MeterAggregation,
  contributions: readonly Contribution[]
): number {
  switch (aggregation) {
    case "sum": {
      let sum = 0;
      for (const c of contributions) sum += c.value;
      return sum;
    }
    case "max": {
      let max = 0;
      let seen = false;
      for (const c of contributions) {
        if (!c.hasEvents) continue; // skip empty windows (matches computeWindowAggregate)
        if (!seen || c.value > max) {
          max = c.value;
          seen = true;
        }
      }
      return seen ? max : 0;
    }
    case "last": {
      // Event times are disjoint across sub-windows, so the globally-latest
      // event lives in the contribution with the greatest last_event_time and
      // its `value` is that event's quantity (the per-window tie-break on
      // ingest_seq is already resolved inside each sub-window).
      let latest: Contribution | null = null;
      for (const c of contributions) {
        if (c.lastEventTime === null) continue;
        if (
          latest === null ||
          c.lastEventTime.getTime() > latest.lastEventTime!.getTime()
        ) {
          latest = c;
        }
      }
      return latest ? latest.value : 0;
    }
    case "unique_count":
      // Never decomposed — handled by the full-recompute branch above.
      return contributions[0]?.value ?? 0;
  }
}
