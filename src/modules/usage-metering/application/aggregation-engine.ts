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
 *   - CHECKPOINT (commit-order safe watermark, issue #900): the cursor floor is
 *     `checkpoint_xid8`, a COMMIT-ordered `xid8` — NOT the INSERT-ordered
 *     `ingest_seq` (which a lower-order producer committing late could sneak
 *     under, permanently under-counting a window: the sql/087 hazard). Each pass
 *     reads `pg_snapshot_xmin(pg_current_snapshot())` and drains only SETTLED
 *     rows (`ingest_xid8 < safe`) from the floor upward, never advancing INTO a
 *     truncated transaction. `checkpoint_seq` is kept as an informational
 *     high-water only. Recompute-from-source + REQUIRED reconciliation remain as
 *     defence-in-depth backstops (see README + sql/099).
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
  /** Commit-order safe-watermark floor (xid8 as a decimal string via Bun.SQL). */
  checkpoint_xid8: string;
  rebuild_requested_at: Date | null;
  rebuild_count: number | string;
};

type BatchRow = {
  /** Commit-order transaction id (xid8 as a decimal string via Bun.SQL). */
  ingest_xid8: string;
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
    SELECT id, checkpoint_seq, checkpoint_xid8::text AS checkpoint_xid8,
           rebuild_requested_at, rebuild_count
    FROM awcms_mini_usage_aggregation_cursors
    WHERE tenant_id = ${tenantId} AND shard_key = 'default'
      AND (lease_holder IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ${now})
    FOR UPDATE SKIP LOCKED
  `) as CursorRow[];
  if (!claimed[0]) {
    return { skipped: true, processed: 0, windowsTouched: 0, rebuilt: false };
  }
  const cursor = claimed[0];
  // The commit-order floor: rows are (re)scanned from `checkpointXid8` upward.
  // `checkpoint_seq` is kept only as an informational high-water (sql/099) and
  // no longer drives batching.
  const checkpointXid8 = BigInt(cursor.checkpoint_xid8);
  const rebuilt = cursor.rebuild_requested_at !== null;

  await tx`
    UPDATE awcms_mini_usage_aggregation_cursors
    SET lease_holder = ${opts.leaseHolder},
        lease_expires_at = ${new Date(now.getTime() + AGGREGATION_LEASE_MS)},
        status = 'leased', updated_at = now()
    WHERE id = ${cursor.id}
  `;

  // COMMIT-ORDER SAFE WATERMARK (issue #900): compute the oldest still-in-flight
  // transaction id ONCE per pass. Every xid8 STRICTLY BELOW `safe` belongs to a
  // settled (committed/aborted) transaction, and no in-flight or future
  // transaction can ever have an xid8 below `safe` — so draining only
  // `ingest_xid8 < safe` guarantees the floor never passes a lower-order row
  // that commits late (the under-count hazard sql/087 documented). A
  // long-running txn holding `safe` back only DELAYS newer rows (conservative,
  // never an under-count); the reconciliation backstop still covers the gap.
  const safeRow = (await tx`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS safe
  `) as { safe: string }[];
  const safe = BigInt(safeRow[0]!.safe);

  // Read the next bounded batch of BOTH streams in COMMIT order (xid8, then
  // ingest_seq within a transaction), only settled rows (`< safe`), re-scanning
  // from the floor (`>= checkpointXid8`).
  const eventBatch = (await tx`
    SELECT ingest_xid8::text AS ingest_xid8, ingest_seq, meter_key, event_time
    FROM awcms_mini_usage_events
    WHERE tenant_id = ${tenantId}
      AND ingest_xid8 >= ${cursor.checkpoint_xid8}::xid8
      AND ingest_xid8 < ${safeRow[0]!.safe}::xid8
    ORDER BY ingest_xid8 ASC, ingest_seq ASC
    LIMIT ${batchLimit}
  `) as BatchRow[];
  const correctionBatch = (await tx`
    SELECT ingest_xid8::text AS ingest_xid8, ingest_seq, meter_key, event_time
    FROM awcms_mini_usage_corrections
    WHERE tenant_id = ${tenantId}
      AND ingest_xid8 >= ${cursor.checkpoint_xid8}::xid8
      AND ingest_xid8 < ${safeRow[0]!.safe}::xid8
    ORDER BY ingest_xid8 ASC, ingest_seq ASC
    LIMIT ${batchLimit}
  `) as BatchRow[];

  // A single transaction (one xid8) can span many rows, so — unlike the old
  // per-row-seq boundary — we must never advance the floor INTO a truncated
  // xid8. `boundary` is an EXCLUSIVE upper bound: this pass processes rows with
  // `ingest_xid8 < boundary` and the floor advances to `boundary`. A FULL stream
  // may have cut off its last xid8 mid-transaction, so we cap `boundary` below
  // that xid8; a DRAINED stream contributes `safe` (everything `< safe` is
  // complete).
  const eventFull = eventBatch.length === batchLimit;
  const correctionFull = correctionBatch.length === batchLimit;
  const eventMaxXid = eventBatch.length
    ? BigInt(eventBatch[eventBatch.length - 1]!.ingest_xid8)
    : null;
  const correctionMaxXid = correctionBatch.length
    ? BigInt(correctionBatch[correctionBatch.length - 1]!.ingest_xid8)
    : null;
  let boundary = safe;
  if (eventFull && eventMaxXid !== null && eventMaxXid < boundary) {
    boundary = eventMaxXid;
  }
  if (
    correctionFull &&
    correctionMaxXid !== null &&
    correctionMaxXid < boundary
  ) {
    boundary = correctionMaxXid;
  }

  let events: BatchRow[];
  let corrections: BatchRow[];
  let newFloor: bigint;

  if (
    boundary <= checkpointXid8 &&
    (eventBatch.length || correctionBatch.length)
  ) {
    // LIVENESS FALLBACK: a single SETTLED transaction (xid8 === checkpointXid8)
    // alone fills a full stream — the per-xid8 boundary rule can't split it, so
    // without this the cursor would live-lock on that one transaction. Because
    // it is `< safe` (committed & complete) there is no reorder hazard: process
    // its ENTIRE window set (re-read ALL of its rows so no window is missed —
    // the batch held only `batchLimit` of them) and advance the floor to the
    // next higher xid8. Bounded by that one transaction's own row count.
    events = (await tx`
      SELECT ingest_xid8::text AS ingest_xid8, ingest_seq, meter_key, event_time
      FROM awcms_mini_usage_events
      WHERE tenant_id = ${tenantId} AND ingest_xid8 = ${cursor.checkpoint_xid8}::xid8
    `) as BatchRow[];
    corrections = (await tx`
      SELECT ingest_xid8::text AS ingest_xid8, ingest_seq, meter_key, event_time
      FROM awcms_mini_usage_corrections
      WHERE tenant_id = ${tenantId} AND ingest_xid8 = ${cursor.checkpoint_xid8}::xid8
    `) as BatchRow[];
    const nextRow = (await tx`
      SELECT LEAST(
        (SELECT min(ingest_xid8) FROM awcms_mini_usage_events
           WHERE tenant_id = ${tenantId}
             AND ingest_xid8 > ${cursor.checkpoint_xid8}::xid8
             AND ingest_xid8 < ${safeRow[0]!.safe}::xid8),
        (SELECT min(ingest_xid8) FROM awcms_mini_usage_corrections
           WHERE tenant_id = ${tenantId}
             AND ingest_xid8 > ${cursor.checkpoint_xid8}::xid8
             AND ingest_xid8 < ${safeRow[0]!.safe}::xid8)
      )::text AS next_floor
    `) as { next_floor: string | null }[];
    newFloor = nextRow[0]?.next_floor ? BigInt(nextRow[0].next_floor) : safe;
  } else {
    const withinBoundary = (row: BatchRow): boolean =>
      BigInt(row.ingest_xid8) < boundary;
    events = eventBatch.filter(withinBoundary);
    corrections = correctionBatch.filter(withinBoundary);
    newFloor = boundary;
  }
  const processed = events.length + corrections.length;

  // The floor is monotonic forward (guarded by the sql/099 trigger); never rewind.
  if (newFloor < checkpointXid8) newFloor = checkpointXid8;

  // Informational high-water only (no longer drives batching): the max ingest_seq
  // among the rows processed this pass.
  let maxProcessedSeq = Number(cursor.checkpoint_seq);
  for (const row of [...events, ...corrections]) {
    const seq = Number(row.ingest_seq);
    if (seq > maxProcessedSeq) maxProcessedSeq = seq;
  }

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

  // Advance the commit-order floor + informational seq high-water, release the
  // lease, clear a consumed rebuild request.
  await tx`
    UPDATE awcms_mini_usage_aggregation_cursors
    SET checkpoint_xid8 = ${newFloor.toString()}::xid8,
        checkpoint_seq = GREATEST(checkpoint_seq, ${maxProcessedSeq}),
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
