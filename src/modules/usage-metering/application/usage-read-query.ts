/**
 * Bounded read queries for the usage timeline + aggregate freshness (Issue
 * #875, epic #868, ADR-0022). All reads run inside the caller's tenant-scoped
 * `tx` (RLS = the acting tenant). Numeric-only DTOs — dimensions are the small
 * admitted map only, never a raw payload.
 */
import type { UsageFreshness } from "../domain/quota-decision";
import type { WindowType } from "../domain/meter-semantics";

/** Below `targetSeconds` old the materialization is `current`; before `staleAfterSeconds` it is `delayed`; at or beyond it is `stale`. */
export const FRESHNESS_TARGET_SECONDS = 300;
export const FRESHNESS_STALE_AFTER_SECONDS = 3600;

export function freshnessOf(
  computedAt: Date | null,
  now: Date
): UsageFreshness {
  if (computedAt === null) {
    return "unavailable";
  }
  const ageSeconds = (now.getTime() - computedAt.getTime()) / 1000;
  if (ageSeconds <= FRESHNESS_TARGET_SECONDS) {
    return "current";
  }
  if (ageSeconds < FRESHNESS_STALE_AFTER_SECONDS) {
    return "delayed";
  }
  return "stale";
}

export type UsageEventDto = {
  id: string;
  meterKey: string;
  producer: string;
  sourceEventId: string;
  sourceVersion: number;
  valueType: string;
  aggregation: string;
  quantity: number;
  uniqueDimension: string | null;
  dimensions: Record<string, string | number>;
  eventTime: string;
  receivedAt: string;
};

type EventRow = {
  id: string;
  meter_key: string;
  producer: string;
  source_event_id: string;
  source_version: number | string;
  value_type: string;
  aggregation: string;
  quantity: number | string;
  unique_dimension: string | null;
  dimensions: Record<string, string | number>;
  event_time: Date;
  received_at: Date;
};

export async function listUsageEvents(
  tx: Bun.SQL,
  tenantId: string,
  meterKey: string | null,
  limit = 200
): Promise<UsageEventDto[]> {
  const capped = Math.min(Math.max(1, limit), 500);
  const rows = (
    meterKey
      ? await tx`
        SELECT id, meter_key, producer, source_event_id, source_version, value_type, aggregation,
          quantity, unique_dimension, dimensions, event_time, received_at
        FROM awcms_mini_usage_events
        WHERE tenant_id = ${tenantId} AND meter_key = ${meterKey}
        ORDER BY ingest_seq DESC
        LIMIT ${capped}
      `
      : await tx`
        SELECT id, meter_key, producer, source_event_id, source_version, value_type, aggregation,
          quantity, unique_dimension, dimensions, event_time, received_at
        FROM awcms_mini_usage_events
        WHERE tenant_id = ${tenantId}
        ORDER BY ingest_seq DESC
        LIMIT ${capped}
      `
  ) as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    meterKey: row.meter_key,
    producer: row.producer,
    sourceEventId: row.source_event_id,
    sourceVersion: Number(row.source_version),
    valueType: row.value_type,
    aggregation: row.aggregation,
    quantity: Number(row.quantity),
    uniqueDimension: row.unique_dimension,
    dimensions: row.dimensions ?? {},
    eventTime: row.event_time.toISOString(),
    receivedAt: row.received_at.toISOString()
  }));
}

export type UsageAggregateDto = {
  meterKey: string;
  windowType: WindowType;
  windowStart: string;
  windowEnd: string;
  valueType: string;
  aggregation: string;
  value: number;
  eventCount: number;
  correctionCount: number;
  distinctCount: number | null;
  lastEventTime: string | null;
  lateEventCount: number;
  contentHash: string;
  windowClosed: boolean;
  computedAt: string;
  freshness: UsageFreshness;
};

type AggregateRow = {
  meter_key: string;
  window_type: WindowType;
  window_start: Date;
  window_end: Date;
  value_type: string;
  aggregation: string;
  aggregate_value: number | string;
  event_count: number | string;
  correction_count: number | string;
  distinct_count: number | string | null;
  last_event_time: Date | null;
  late_event_count: number | string;
  content_hash: string;
  window_closed: boolean;
  computed_at: Date;
};

function toAggregateDto(row: AggregateRow, now: Date): UsageAggregateDto {
  return {
    meterKey: row.meter_key,
    windowType: row.window_type,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    valueType: row.value_type,
    aggregation: row.aggregation,
    value: Number(row.aggregate_value),
    eventCount: Number(row.event_count),
    correctionCount: Number(row.correction_count),
    distinctCount:
      row.distinct_count === null ? null : Number(row.distinct_count),
    lastEventTime: row.last_event_time?.toISOString() ?? null,
    lateEventCount: Number(row.late_event_count),
    contentHash: row.content_hash,
    windowClosed: row.window_closed,
    computedAt: row.computed_at.toISOString(),
    freshness: freshnessOf(row.computed_at, now)
  };
}

export async function listAggregates(
  tx: Bun.SQL,
  tenantId: string,
  meterKey: string | null,
  windowType: WindowType | null,
  now: Date,
  limit = 200
): Promise<UsageAggregateDto[]> {
  const capped = Math.min(Math.max(1, limit), 500);
  const rows = (await tx`
    SELECT meter_key, window_type, window_start, window_end, value_type, aggregation,
      aggregate_value, event_count, correction_count, distinct_count, last_event_time,
      late_event_count, content_hash, window_closed, computed_at
    FROM awcms_mini_usage_aggregates
    WHERE tenant_id = ${tenantId}
      AND (${meterKey}::text IS NULL OR meter_key = ${meterKey})
      AND (${windowType}::text IS NULL OR window_type = ${windowType})
    ORDER BY meter_key ASC, window_type ASC, window_start DESC
    LIMIT ${capped}
  `) as AggregateRow[];
  return rows.map((row) => toAggregateDto(row, now));
}
