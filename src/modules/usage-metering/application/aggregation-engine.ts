/**
 * Aggregation engine (Issue #875, epic #868, ADR-0022). The async, resumable
 * worker that DETERMINISTICALLY materializes usage windows from the immutable
 * events + corrections — OUTSIDE the producers' commit (the events table is the
 * transactional outbox it drains).
 *
 * LEASE + CHECKPOINT + BOUNDED BATCH + RETRY + REPLAY (issue #875 scope):
 *   - LEASE: the per-tenant cursor row is claimed `FOR UPDATE SKIP LOCKED` with
 *     an expired-reclaimable predicate (`lease_holder IS NULL OR lease_expires_at
 *     < now`) so a crashed worker's lease is reclaimed on restart, and two
 *     workers never process the same tenant at once.
 *   - CHECKPOINT: `checkpoint_seq` (the merged event+correction ingest cursor)
 *     only advances forward past a boundary BOTH streams have been fully read up
 *     to (never skipping an unread row of a full batch).
 *   - BOUNDED BATCH: at most `batchLimit` rows per stream per pass.
 *   - RETRY: on any error the whole transaction rolls back — the lease is never
 *     committed and the checkpoint never advances, so the next run retries from
 *     the last durable checkpoint.
 *   - REPLAY: each touched window is RECOMPUTED-FROM-SOURCE (not incrementally
 *     accumulated), so reprocessing the same events is idempotent and never
 *     double-counts. This is also why a rebuild reproduces stored aggregates.
 *
 * LATE / OUT-OF-ORDER events: an event's window is chosen by its `event_time`
 * (not arrival order), so a late event simply recomputes its (possibly already
 * closed) window deterministically and increments that window's
 * `late_event_count`. A window is `closed` once `now >= window_end + grace`;
 * closing is one-way and informational — a closed window's value still reflects
 * later arrivals (which reconciliation would otherwise flag as drift).
 */
import {
  computeContentHash,
  computeWindowAggregate,
  contentHashProjection,
  windowEndFor,
  windowStartFor,
  WINDOW_TYPES,
  type WindowType
} from "../domain/meter-semantics";
import { resolveMeter, type SaasContractRegistry } from "./meter-registry";
import { readWindowSources } from "./usage-source-query";

export const AGGREGATION_LEASE_MS = 60_000;
export const AGGREGATION_DEFAULT_BATCH_LIMIT = 500;
/** A window is considered closed for late-arrival accounting once now is this far past its end. */
export const AGGREGATION_LATENESS_GRACE_MS = 3_600_000; // 1 hour

type TouchedWindow = {
  meterKey: string;
  windowType: WindowType;
  windowStart: Date;
};

/**
 * Recompute a single window from the immutable source and UPSERT it. Idempotent:
 * calling it repeatedly for the same window yields the identical stored row.
 * Returns `false` for an unknown meter (fail-closed — leaves any stored row
 * untouched so reconciliation can surface it).
 */
export async function recomputeWindow(
  tx: Bun.SQL,
  tenantId: string,
  registry: SaasContractRegistry,
  meterKey: string,
  windowType: WindowType,
  windowStart: Date,
  now: Date
): Promise<boolean> {
  const meter = resolveMeter(registry, meterKey);
  if (!meter) {
    return false;
  }
  const windowEnd = windowEndFor(windowType, windowStart);
  const closedBefore = new Date(
    windowEnd.getTime() + AGGREGATION_LATENESS_GRACE_MS
  );
  const windowClosed = now.getTime() >= closedBefore.getTime();

  const sources = await readWindowSources(
    tx,
    tenantId,
    meterKey,
    windowStart,
    windowEnd,
    closedBefore
  );
  const aggregate = computeWindowAggregate(
    meter.aggregation,
    meter.valueType,
    sources.events,
    sources.corrections
  );
  const contentHash = computeContentHash(
    contentHashProjection({
      meterKey,
      windowType,
      windowStart,
      windowEnd,
      aggregation: meter.aggregation,
      valueType: meter.valueType,
      aggregate
    })
  );

  await tx`
    INSERT INTO awcms_mini_usage_aggregates
      (tenant_id, meter_key, window_type, window_start, window_end, value_type, aggregation,
       aggregate_value, event_count, correction_count, distinct_count, last_event_time,
       late_event_count, source_watermark, content_hash, window_closed, computed_at)
    VALUES (
      ${tenantId}, ${meterKey}, ${windowType}, ${windowStart}, ${windowEnd},
      ${meter.valueType}, ${meter.aggregation}, ${aggregate.value}, ${aggregate.eventCount},
      ${aggregate.correctionCount}, ${aggregate.distinctCount}, ${aggregate.lastEventTime},
      ${sources.lateEventCount}, ${sources.watermark}, ${contentHash}, ${windowClosed}, ${now}
    )
    ON CONFLICT (tenant_id, meter_key, window_type, window_start) DO UPDATE SET
      aggregate_value = EXCLUDED.aggregate_value,
      event_count = EXCLUDED.event_count,
      correction_count = EXCLUDED.correction_count,
      distinct_count = EXCLUDED.distinct_count,
      last_event_time = EXCLUDED.last_event_time,
      late_event_count = EXCLUDED.late_event_count,
      source_watermark = GREATEST(awcms_mini_usage_aggregates.source_watermark, EXCLUDED.source_watermark),
      content_hash = EXCLUDED.content_hash,
      window_closed = awcms_mini_usage_aggregates.window_closed OR EXCLUDED.window_closed,
      computed_at = EXCLUDED.computed_at,
      updated_at = now()
  `;
  return true;
}

export type AggregateTenantResult = {
  skipped: boolean;
  processed: number;
  windowsTouched: number;
  rebuilt: boolean;
};

type CursorRow = {
  id: string;
  checkpoint_seq: number | string;
  rebuild_requested_at: Date | null;
  rebuild_count: number | string;
};

type BatchRow = {
  ingest_seq: number | string;
  meter_key: string;
  event_time: Date;
};

/**
 * Process one bounded pass of aggregation for a tenant. Claims the lease, reads
 * the next batch of the merged event+correction stream, recomputes every touched
 * window from source, advances the checkpoint, and (if a rebuild was requested)
 * recomputes every existing window. Returns `{ skipped: true }` when another
 * worker holds a fresh lease.
 */
export async function aggregateTenant(
  tx: Bun.SQL,
  tenantId: string,
  registry: SaasContractRegistry,
  opts: { leaseHolder: string; batchLimit?: number; now?: Date }
): Promise<AggregateTenantResult> {
  const now = opts.now ?? new Date();
  const batchLimit = opts.batchLimit ?? AGGREGATION_DEFAULT_BATCH_LIMIT;

  // Ensure the cursor row exists, then claim it with the expired-reclaimable
  // predicate — SKIP LOCKED so a busy tenant is skipped, not blocked on.
  await tx`
    INSERT INTO awcms_mini_usage_aggregation_cursors (tenant_id, shard_key)
    VALUES (${tenantId}, 'default')
    ON CONFLICT (tenant_id, shard_key) DO NOTHING
  `;
  const claimed = (await tx`
    SELECT id, checkpoint_seq, rebuild_requested_at, rebuild_count
    FROM awcms_mini_usage_aggregation_cursors
    WHERE tenant_id = ${tenantId} AND shard_key = 'default'
      AND (lease_holder IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ${now})
    FOR UPDATE SKIP LOCKED
  `) as CursorRow[];
  if (!claimed[0]) {
    return { skipped: true, processed: 0, windowsTouched: 0, rebuilt: false };
  }
  const cursor = claimed[0];
  const checkpoint = Number(cursor.checkpoint_seq);
  const rebuilt = cursor.rebuild_requested_at !== null;

  await tx`
    UPDATE awcms_mini_usage_aggregation_cursors
    SET lease_holder = ${opts.leaseHolder},
        lease_expires_at = ${new Date(now.getTime() + AGGREGATION_LEASE_MS)},
        status = 'leased', updated_at = now()
    WHERE id = ${cursor.id}
  `;

  // Read the next bounded batch of BOTH streams.
  const eventBatch = (await tx`
    SELECT ingest_seq, meter_key, event_time
    FROM awcms_mini_usage_events
    WHERE tenant_id = ${tenantId} AND ingest_seq > ${checkpoint}
    ORDER BY ingest_seq ASC
    LIMIT ${batchLimit}
  `) as BatchRow[];
  const correctionBatch = (await tx`
    SELECT ingest_seq, meter_key, event_time
    FROM awcms_mini_usage_corrections
    WHERE tenant_id = ${tenantId} AND ingest_seq > ${checkpoint}
    ORDER BY ingest_seq ASC
    LIMIT ${batchLimit}
  `) as BatchRow[];

  // Advance only past a boundary BOTH streams have been fully read up to (a full
  // batch may have more rows beyond its max — never skip them).
  const eventFull = eventBatch.length === batchLimit;
  const correctionFull = correctionBatch.length === batchLimit;
  const eventMax = eventBatch.length
    ? Number(eventBatch[eventBatch.length - 1]!.ingest_seq)
    : checkpoint;
  const correctionMax = correctionBatch.length
    ? Number(correctionBatch[correctionBatch.length - 1]!.ingest_seq)
    : checkpoint;
  let boundary = Number.POSITIVE_INFINITY;
  if (eventFull) boundary = Math.min(boundary, eventMax);
  if (correctionFull) boundary = Math.min(boundary, correctionMax);

  const withinBoundary = (row: BatchRow): boolean =>
    !Number.isFinite(boundary) || Number(row.ingest_seq) <= boundary;
  const events = eventBatch.filter(withinBoundary);
  const corrections = correctionBatch.filter(withinBoundary);
  const processed = events.length + corrections.length;

  // Collect the distinct (meter, windowType, windowStart) windows the batch touched.
  const touched = new Map<string, TouchedWindow>();
  for (const row of [...events, ...corrections]) {
    for (const windowType of WINDOW_TYPES) {
      const windowStart = windowStartFor(windowType, row.event_time);
      const key = `${row.meter_key}|${windowType}|${windowStart.toISOString()}`;
      if (!touched.has(key)) {
        touched.set(key, { meterKey: row.meter_key, windowType, windowStart });
      }
    }
  }

  let windowsTouched = 0;
  for (const window of touched.values()) {
    const ok = await recomputeWindow(
      tx,
      tenantId,
      registry,
      window.meterKey,
      window.windowType,
      window.windowStart,
      now
    );
    if (ok) windowsTouched += 1;
  }

  // A requested rebuild recomputes EVERY existing window from source (repairs
  // any historical drift). Bounded by the tenant's window count.
  if (rebuilt) {
    const existing = (await tx`
      SELECT meter_key, window_type, window_start
      FROM awcms_mini_usage_aggregates
      WHERE tenant_id = ${tenantId}
      ORDER BY meter_key, window_type, window_start
    `) as { meter_key: string; window_type: WindowType; window_start: Date }[];
    for (const row of existing) {
      await recomputeWindow(
        tx,
        tenantId,
        registry,
        row.meter_key,
        row.window_type,
        row.window_start,
        now
      );
    }
  }

  const newCheckpoint =
    processed === 0
      ? checkpoint
      : Number.isFinite(boundary)
        ? boundary
        : Math.max(eventMax, correctionMax);

  // Advance the checkpoint, release the lease, clear a consumed rebuild request.
  await tx`
    UPDATE awcms_mini_usage_aggregation_cursors
    SET checkpoint_seq = GREATEST(checkpoint_seq, ${newCheckpoint}),
        lease_holder = NULL, lease_expires_at = NULL, status = 'idle',
        last_run_at = ${now}, last_error = NULL, consecutive_failures = 0,
        processed_event_total = processed_event_total + ${processed},
        rebuild_requested_at = ${rebuilt ? null : cursor.rebuild_requested_at},
        rebuild_count = ${Number(cursor.rebuild_count) + (rebuilt ? 1 : 0)},
        updated_at = now()
    WHERE id = ${cursor.id}
  `;

  return { skipped: false, processed, windowsTouched, rebuilt };
}
