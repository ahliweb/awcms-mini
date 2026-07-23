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
 *     one sub-window (or fails closed if it alone blows the budget).
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
 * closed). Reconciliation remains the defence-in-depth backstop for the residual
 * "settled sub-aggregate present but stale beyond the grace window" case (the
 * same accepted tradeoff the aggregation engine documents).
 *
 * SECURITY INVARIANT (adversarially tested): usage returned here is NEVER lower
 * than the true committed usage — worker lag falls back to a bounded live
 * recompute or fails closed; budget/error fail closed. All reads run inside the
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
    const rows = (await tx`
      SELECT window_start, aggregate_value, event_count, last_event_time
      FROM awcms_mini_usage_aggregates
      WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
        AND window_type = ${subType}
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
    // Walk every settled sub-window; a MISSING one is recomputed from source
    // (bounded to that one sub-window) — never assumed 0 (would over-admit).
    for (
      let subStart = start;
      subStart < settledEnd;
      subStart = windowEndFor(subType, subStart)
    ) {
      const hit = byStart.get(subStart.getTime());
      if (hit) {
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
