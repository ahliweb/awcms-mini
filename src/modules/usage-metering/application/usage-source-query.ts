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
