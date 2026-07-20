/**
 * Meter aggregation semantics (Issue #875, epic #868 SaaS control plane,
 * ADR-0022). PURE — no I/O. The deterministic core: how a meter's samples bucket
 * into calendar windows and combine per its #874 aggregation, plus the
 * content-hash projection that makes a rebuild reproducible.
 *
 * DETERMINISM INVARIANT (issue #875 AC). A window's aggregate is a PURE function
 * of the immutable events + corrections whose `event_time` falls in the window
 * — never of ingest/received order. So a rebuild (recompute-from-source)
 * reproduces the stored value byte-for-byte, and reprocessing the same event
 * twice (a replayed/crashed worker run) never double-counts. Reconciliation
 * recomputes with this same function and flags any stored aggregate that drifts.
 *
 * SUPPORTED AGGREGATIONS (from #874, "only where safe and explicitly admitted"):
 *   - `sum`          — Σ event.quantity + Σ correction.delta (the only
 *                      aggregation signed corrections apply to; a correction is
 *                      itself a signed delta on the original event's window).
 *   - `max`          — peak event.quantity (a gauge peak). Corrections are not
 *                      admitted for max/last/unique_count meters (the #874
 *                      descriptor's `correction` must be `none`).
 *   - `last`         — the quantity of the latest event (max event_time, tie-
 *                      broken by max ingest_seq — a deterministic total order).
 *   - `unique_count` — distinct count of a pseudonymous `unique_dimension`.
 */
import { createHash } from "node:crypto";

export type WindowType = "hour" | "day" | "month";
export const WINDOW_TYPES: readonly WindowType[] = ["hour", "day", "month"];

export type MeterAggregation = "sum" | "max" | "last" | "unique_count";
export type MeterValueType =
  "count" | "gauge" | "amount_minor" | "duration_seconds" | "bytes";

/** JS integer-precision floor/ceiling — matches the DB CHECK bounds in sql/087. */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
export const MIN_SAFE = Number.MIN_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Calendar window bucketing (UTC-aligned, deterministic)
// ---------------------------------------------------------------------------

/** The UTC-aligned start of the window of `type` that contains `at`. */
export function windowStartFor(type: WindowType, at: Date): Date {
  const y = at.getUTCFullYear();
  const mo = at.getUTCMonth();
  const d = at.getUTCDate();
  const h = at.getUTCHours();
  switch (type) {
    case "hour":
      return new Date(Date.UTC(y, mo, d, h, 0, 0, 0));
    case "day":
      return new Date(Date.UTC(y, mo, d, 0, 0, 0, 0));
    case "month":
      return new Date(Date.UTC(y, mo, 1, 0, 0, 0, 0));
  }
}

/** The exclusive end of the window that starts at `start` for `type`. */
export function windowEndFor(type: WindowType, start: Date): Date {
  const y = start.getUTCFullYear();
  const mo = start.getUTCMonth();
  const d = start.getUTCDate();
  const h = start.getUTCHours();
  switch (type) {
    case "hour":
      return new Date(Date.UTC(y, mo, d, h + 1, 0, 0, 0));
    case "day":
      return new Date(Date.UTC(y, mo, d + 1, 0, 0, 0, 0));
    case "month":
      return new Date(Date.UTC(y, mo + 1, 1, 0, 0, 0, 0));
  }
}

export type WindowBounds = { start: Date; end: Date };

/** The bounds of the `type` window that contains `at`. */
export function windowBoundsFor(type: WindowType, at: Date): WindowBounds {
  const start = windowStartFor(type, at);
  return { start, end: windowEndFor(type, start) };
}

/**
 * A quota's reset period (#874) mapped to the coarsest supported calendar
 * window. `weekly` has no native calendar window here and falls back to `day`
 * (a documented approximation); `quarterly`/`yearly`/`billing_cycle`/`none` map
 * to the current calendar `month` as a BOUNDED, deterministic proxy — true
 * billing-cycle windows are owned by #876 (subscription billing) and are out of
 * scope for this metering foundation. `daily`/`monthly` map exactly.
 */
export function windowTypeForResetPeriod(resetPeriod: string): WindowType {
  switch (resetPeriod) {
    case "daily":
    case "weekly":
      return "day";
    default:
      // monthly, quarterly, yearly, billing_cycle, none
      return "month";
  }
}

// ---------------------------------------------------------------------------
// Deterministic aggregation
// ---------------------------------------------------------------------------

export type AggregationSourceEvent = {
  ingestSeq: number;
  quantity: number;
  uniqueDimension: string | null;
  eventTime: Date;
};

export type AggregationSourceCorrection = {
  ingestSeq: number;
  deltaQuantity: number;
  eventTime: Date;
};

export type WindowAggregate = {
  aggregation: MeterAggregation;
  valueType: MeterValueType;
  value: number;
  eventCount: number;
  correctionCount: number;
  /** Only for `unique_count` (equals `value`); `null` otherwise. */
  distinctCount: number | null;
  /** Only for `last` (the latest event's time); `null` otherwise. */
  lastEventTime: Date | null;
};

/**
 * Compute a window's aggregate DETERMINISTICALLY from all its events +
 * corrections. Order-independent (both `max` and `unique_count` are set/peak
 * operations; `last` uses a total order on (eventTime, ingestSeq); `sum` is
 * commutative), so a replayed run reproduces the identical value.
 */
export function computeWindowAggregate(
  aggregation: MeterAggregation,
  valueType: MeterValueType,
  events: readonly AggregationSourceEvent[],
  corrections: readonly AggregationSourceCorrection[]
): WindowAggregate {
  const base: Omit<
    WindowAggregate,
    "value" | "distinctCount" | "lastEventTime"
  > = {
    aggregation,
    valueType,
    eventCount: events.length,
    correctionCount: corrections.length
  };

  switch (aggregation) {
    case "sum": {
      let sum = 0;
      for (const e of events) sum += e.quantity;
      for (const c of corrections) sum += c.deltaQuantity;
      return { ...base, value: sum, distinctCount: null, lastEventTime: null };
    }
    case "max": {
      let max = 0;
      let seen = false;
      for (const e of events) {
        if (!seen || e.quantity > max) {
          max = e.quantity;
          seen = true;
        }
      }
      return {
        ...base,
        value: seen ? max : 0,
        distinctCount: null,
        lastEventTime: null
      };
    }
    case "last": {
      let latest: AggregationSourceEvent | null = null;
      for (const e of events) {
        if (
          latest === null ||
          e.eventTime.getTime() > latest.eventTime.getTime() ||
          (e.eventTime.getTime() === latest.eventTime.getTime() &&
            e.ingestSeq > latest.ingestSeq)
        ) {
          latest = e;
        }
      }
      return {
        ...base,
        value: latest ? latest.quantity : 0,
        distinctCount: null,
        lastEventTime: latest ? latest.eventTime : null
      };
    }
    case "unique_count": {
      const distinct = new Set<string>();
      for (const e of events) {
        if (e.uniqueDimension !== null && e.uniqueDimension.length > 0) {
          distinct.add(e.uniqueDimension);
        }
      }
      return {
        ...base,
        value: distinct.size,
        distinctCount: distinct.size,
        lastEventTime: null
      };
    }
  }
}

/**
 * The EXACT projection the content hash covers — and it must be EXACTLY the
 * shape the `usage_aggregate` port exposes to consumers (billing #876): the
 * deterministic window identity + numeric aggregate. Epic pattern #5 ("hash
 * only what is exposed, no oracle"): everything hashed here is operational and
 * tenant/consumer-visible (no operator secrets, no internal prices), so this
 * can never become an oracle. Excludes `computed_at`/watermarks so two
 * recomputations of the same source hash identically (reproducibility).
 */
export function contentHashProjection(input: {
  meterKey: string;
  windowType: WindowType;
  windowStart: Date;
  windowEnd: Date;
  aggregation: MeterAggregation;
  valueType: MeterValueType;
  aggregate: WindowAggregate;
}): Record<string, unknown> {
  return {
    meterKey: input.meterKey,
    windowType: input.windowType,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    aggregation: input.aggregation,
    valueType: input.valueType,
    value: input.aggregate.value,
    eventCount: input.aggregate.eventCount,
    correctionCount: input.aggregate.correctionCount,
    distinctCount: input.aggregate.distinctCount,
    lastEventTime: input.aggregate.lastEventTime?.toISOString() ?? null
  };
}

export function computeContentHash(
  projection: Record<string, unknown>
): string {
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}
