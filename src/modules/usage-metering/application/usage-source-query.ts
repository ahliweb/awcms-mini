/**
 * Bounded reads of the IMMUTABLE source (Issue #875, epic #868, ADR-0022). The
 * one place events + corrections for a (meter, window) are fetched — shared by
 * the aggregation engine, reconciliation, and the authoritative quota
 * recompute, so all three see the same source and produce the same deterministic
 * result. All reads run inside the caller's tenant-scoped `tx` (RLS = the acting
 * tenant); a tenant can never read another tenant's usage.
 */
import type {
  AggregationSourceCorrection,
  AggregationSourceEvent
} from "../domain/meter-semantics";

export type WindowSources = {
  events: AggregationSourceEvent[];
  corrections: AggregationSourceCorrection[];
  /** Max ingest_seq across the window's events + corrections (0 if empty) — the window's source watermark. */
  watermark: number;
  /** Count of events whose `received_at` is after `closedBefore` (late arrivals). */
  lateEventCount: number;
};

type EventRow = {
  ingest_seq: number | string;
  quantity: number | string;
  unique_dimension: string | null;
  event_time: Date;
  received_at: Date;
};

type CorrectionRow = {
  ingest_seq: number | string;
  delta_quantity: number | string;
  event_time: Date;
};

/** Shared row → domain projection (identical for the unbounded + bounded reads). */
function mapWindowSources(
  eventRows: EventRow[],
  correctionRows: CorrectionRow[],
  closedBefore: Date | null
): WindowSources {
  let watermark = 0;
  let lateEventCount = 0;
  const events: AggregationSourceEvent[] = eventRows.map((row) => {
    const ingestSeq = Number(row.ingest_seq);
    if (ingestSeq > watermark) watermark = ingestSeq;
    if (
      closedBefore !== null &&
      row.received_at.getTime() >= closedBefore.getTime()
    ) {
      lateEventCount += 1;
    }
    return {
      ingestSeq,
      quantity: Number(row.quantity),
      uniqueDimension: row.unique_dimension,
      eventTime: row.event_time
    };
  });

  const corrections: AggregationSourceCorrection[] = correctionRows.map(
    (row) => {
      const ingestSeq = Number(row.ingest_seq);
      if (ingestSeq > watermark) watermark = ingestSeq;
      return {
        ingestSeq,
        deltaQuantity: Number(row.delta_quantity),
        eventTime: row.event_time
      };
    }
  );

  return { events, corrections, watermark, lateEventCount };
}

/**
 * Read every event + correction for a meter whose `event_time` falls in
 * [windowStart, windowEnd). `closedBefore` (typically `windowEnd + grace`) is
 * used only to count late arrivals — it never affects the aggregate value
 * (determinism: the value depends on event_time + quantity only, never on
 * received order).
 */
export async function readWindowSources(
  tx: Bun.SQL,
  tenantId: string,
  meterKey: string,
  windowStart: Date,
  windowEnd: Date,
  closedBefore: Date | null
): Promise<WindowSources> {
  const eventRows = (await tx`
    SELECT ingest_seq, quantity, unique_dimension, event_time, received_at
    FROM awcms_mini_usage_events
    WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
      AND event_time >= ${windowStart} AND event_time < ${windowEnd}
    ORDER BY ingest_seq ASC
  `) as EventRow[];

  const correctionRows = (await tx`
    SELECT ingest_seq, delta_quantity, event_time
    FROM awcms_mini_usage_corrections
    WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
      AND event_time >= ${windowStart} AND event_time < ${windowEnd}
    ORDER BY ingest_seq ASC
  `) as CorrectionRow[];

  return mapWindowSources(eventRows, correctionRows, closedBefore);
}

export type BoundedWindowSources = WindowSources & {
  /**
   * `true` when the window holds MORE than `maxRows` source rows (events +
   * corrections). When set, `events`/`corrections` are EMPTY and MUST NOT be
   * used — the caller fails closed (an unbounded read here is the sql/901
   * over-recompute hazard). Never silently truncated: truncating would
   * under-count and over-admit a hard quota.
   */
  overBudget: boolean;
};

/**
 * Like `readWindowSources` but capped at `maxRows` TOTAL rows across the
 * event + correction streams (the sql/901 query-plan / row budget). Reads at
 * most `maxRows + 1` rows per stream (a `LIMIT` tripwire), stops as soon as the
 * combined count would exceed `maxRows`, and signals `overBudget` instead of
 * returning a partial (would-under-count) result. Used by the bounded quota
 * recompute for the open tail + any settled-but-unmaterialized sub-window.
 */
export async function readWindowSourcesBounded(
  tx: Bun.SQL,
  tenantId: string,
  meterKey: string,
  windowStart: Date,
  windowEnd: Date,
  closedBefore: Date | null,
  maxRows: number
): Promise<BoundedWindowSources> {
  const empty: BoundedWindowSources = {
    events: [],
    corrections: [],
    watermark: 0,
    lateEventCount: 0,
    overBudget: true
  };
  const eventRows = (await tx`
    SELECT ingest_seq, quantity, unique_dimension, event_time, received_at
    FROM awcms_mini_usage_events
    WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
      AND event_time >= ${windowStart} AND event_time < ${windowEnd}
    ORDER BY ingest_seq ASC
    LIMIT ${maxRows + 1}
  `) as EventRow[];
  if (eventRows.length > maxRows) {
    return empty;
  }
  const correctionBudget = maxRows - eventRows.length;
  const correctionRows = (await tx`
    SELECT ingest_seq, delta_quantity, event_time
    FROM awcms_mini_usage_corrections
    WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
      AND event_time >= ${windowStart} AND event_time < ${windowEnd}
    ORDER BY ingest_seq ASC
    LIMIT ${correctionBudget + 1}
  `) as CorrectionRow[];
  if (correctionRows.length > correctionBudget) {
    return empty;
  }
  return {
    ...mapWindowSources(eventRows, correctionRows, closedBefore),
    overBudget: false
  };
}
