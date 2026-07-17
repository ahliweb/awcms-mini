/**
 * Groups deferred visitor telemetry into per-tenant batches so that N
 * concurrent visits cost ONE transaction instead of N (Issue #846, epic
 * #818).
 *
 * ## Why this exists (measured, not assumed)
 *
 * Issue #832 took the telemetry write off the response path
 * (`telemetry-queue.ts`), which fixed TTFB but left the write itself
 * per-event: every public visit still opened its own transaction. Measured
 * through a round-trip-counting TCP proxy against a real Postgres, that is
 * **5.2 round trips per visit** — BEGIN, SET LOCAL, SELECT session, INSERT
 * event, COMMIT — of which the INSERT that Issue #846's title named is only
 * ~19%. The dominant cost was the per-event transaction scaffolding (~58%),
 * so this module batches the *transaction*, not the INSERT. See
 * `collector.ts`'s header for the full decomposition.
 *
 * ## Two stages, and why
 *
 * `telemetry-queue.ts` (stage 1) still defers work off the response path;
 * its tasks resolve the tenant (usually a cache hit, zero round trips),
 * which is what makes per-tenant grouping possible at all — a batch is
 * necessarily per-tenant, because `withTenant` sets one tenant per
 * transaction. Those tasks then land here (stage 2), where records
 * accumulate briefly and flush together.
 *
 * ## The batching trade, chosen deliberately
 *
 * Batching widens the window in which un-written events exist only in
 * memory. That is a real cost and it is accepted here for these reasons:
 *
 * - **Hard crash (SIGKILL, OOM, panic): up to `BATCH_LINGER_MS` of traffic
 *   per tenant, or `MAX_BATCH_SIZE` events, can be lost** — versus at most
 *   the in-flight events before. This is a genuine widening. It is
 *   acceptable *for this data only*: visitor analytics is already
 *   explicitly lossy by design (the bounded queue drops on overflow, the
 *   flush drops on timeout, the collector is fail-open), and it is
 *   aggregate statistical data where a sub-second gap during an abnormal
 *   termination changes no decision. This reasoning does NOT transfer to
 *   any ledger/audit/posted-transaction write.
 * - **Graceful shutdown (SIGTERM/SIGINT): zero additional loss.**
 *   `flushVisitEventBatches` flushes PARTIAL batches on demand — it never
 *   waits for a batch to reach `MAX_BATCH_SIZE` or for its linger timer to
 *   expire. A batcher that could only flush full batches would silently
 *   lose the tail of every deploy, which is precisely the regression Issue
 *   #846 warned against and `tests/unit/visit-event-batcher.test.ts`
 *   guards.
 * - **Bounded, and loud when it drops.** `MAX_PENDING_EVENTS` caps total
 *   buffered records; overflow drops the NEW record (never evicting older
 *   ones already closer to being written), counted on
 *   `visitor_analytics_batch_dropped_total` and logged at `warning` — the
 *   same backpressure contract stage 1 already has, not a quieter one.
 *
 * `BATCH_LINGER_MS` is the dial between these: larger batches amortize more
 * round trips but widen the crash window. 200ms is chosen to be
 * imperceptible to the crash-loss argument above while still coalescing
 * meaningfully at the traffic levels where any of this matters.
 */
import { log } from "../../../lib/logging/logger";
import {
  recordCounter,
  recordGauge
} from "../../../lib/observability/metrics-port";
import { writeVisitEventBatch, type VisitEventRecord } from "./collector";

/**
 * How long a tenant's records wait for company before being written.
 * Deliberately short: this is the crash-loss window (see header), and the
 * amortization curve is steep — even a handful of coalesced events removes
 * most of the per-event round trips.
 */
export const BATCH_LINGER_MS = 200;

/**
 * Flush a tenant's bucket as soon as it holds this many records, without
 * waiting out the linger. Bounds both the crash window and the size of any
 * single multi-row statement under a traffic spike.
 */
export const MAX_BATCH_SIZE = 50;

/**
 * Global cap on buffered-but-unwritten records across all tenants. Mirrors
 * `telemetry-queue.ts`'s `MAX_QUEUE_DEPTH` contract: telemetry is the
 * lowest-value work in the process and must never grow memory without
 * bound, so past this cap the NEW record is dropped and counted.
 */
export const MAX_PENDING_EVENTS = 1_000;

type Bucket = {
  sql: Bun.SQL;
  records: VisitEventRecord[];
  timer: ReturnType<typeof setTimeout> | null;
};

const buckets = new Map<string, Bucket>();
const inFlight = new Set<Promise<void>>();
let pendingCount = 0;

function clearBucketTimer(bucket: Bucket): void {
  if (bucket.timer) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }
}

/**
 * Detaches a tenant's current records and writes them. Never throws —
 * `writeVisitEventBatch` already contains every failure, and this is
 * belt-and-braces so nothing can escape as an unhandled rejection (which
 * would turn "analytics is fail-open" into "analytics can kill the
 * server").
 */
function flushBucket(tenantId: string): Promise<void> {
  const bucket = buckets.get(tenantId);

  if (!bucket || bucket.records.length === 0) {
    return Promise.resolve();
  }

  clearBucketTimer(bucket);

  // Detach BEFORE awaiting: records arriving during the write belong to the
  // next batch, and must not be silently discarded by this one's completion.
  const records = bucket.records;
  bucket.records = [];
  pendingCount -= records.length;
  buckets.delete(tenantId);
  recordGauge("visitor_analytics_batch_pending", pendingCount);

  const promise = (async () => {
    try {
      await writeVisitEventBatch(bucket.sql, tenantId, records);
    } catch (error) {
      log("warning", "visitor_analytics.batch.flush_failed", {
        moduleKey: "visitor_analytics",
        tenantId,
        batchSize: records.length,
        error: error instanceof Error ? error.message : "unknown error"
      });
    }
  })().finally(() => {
    inFlight.delete(promise);
  });

  inFlight.add(promise);

  return promise;
}

/**
 * Buffers one record for `tenantId`. Synchronous and never throws — the
 * caller (a stage-1 queue task) must not be able to block on the write.
 */
export function enqueueVisitEvent(
  sql: Bun.SQL,
  tenantId: string,
  record: VisitEventRecord
): void {
  if (pendingCount >= MAX_PENDING_EVENTS) {
    recordCounter("visitor_analytics_batch_dropped_total");
    log("warning", "visitor_analytics.batch.overflow", {
      moduleKey: "visitor_analytics",
      tenantId,
      pendingCount
    });

    return;
  }

  let bucket = buckets.get(tenantId);

  if (!bucket) {
    bucket = { sql, records: [], timer: null };
    buckets.set(tenantId, bucket);
  }

  bucket.records.push(record);
  pendingCount += 1;
  recordGauge("visitor_analytics_batch_pending", pendingCount);

  if (bucket.records.length >= MAX_BATCH_SIZE) {
    void flushBucket(tenantId);

    return;
  }

  if (!bucket.timer) {
    const timer = setTimeout(() => {
      void flushBucket(tenantId);
    }, BATCH_LINGER_MS);

    // A pending linger timer must never be the reason the process stays
    // alive — shutdown is `flushVisitEventBatches`'s job, on demand, not a
    // timer's. Without `unref` an idle server would also keep the event
    // loop warm for no reason, and `beforeExit` would never fire.
    timer.unref?.();
    bucket.timer = timer;
  }
}

/**
 * Writes every buffered record — including PARTIAL batches — and waits for
 * all in-flight writes to finish. This is what makes batching safe at
 * shutdown: it never waits for a batch to fill or for a linger timer.
 *
 * Loops because a flush that is already in flight does not prevent new
 * records from arriving (a stage-1 task may still be draining), and those
 * would otherwise be left behind. Bounded by `timeoutMs` so a hung database
 * cannot hold shutdown open forever — on timeout the remaining records ARE
 * lost, logged loudly rather than swallowed.
 */
export async function flushVisitEventBatches(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (buckets.size > 0 || inFlight.size > 0) {
    if (Date.now() >= deadline) {
      log("warning", "visitor_analytics.batch.flush_timeout", {
        moduleKey: "visitor_analytics",
        pendingCount,
        buckets: buckets.size,
        inFlight: inFlight.size,
        timeoutMs
      });

      return;
    }

    // Snapshot the keys: flushBucket mutates `buckets`.
    for (const tenantId of [...buckets.keys()]) {
      void flushBucket(tenantId);
    }

    if (inFlight.size > 0) {
      const remaining = deadline - Date.now();

      // Each in-flight write is a SEPARATE tenant's transaction on its own
      // connection, so awaiting them together is safe — unlike concurrent
      // queries on a single `tx`, which deadlock the connection.
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, remaining));
          timer.unref?.();
        })
      ]);
    }
  }
}

/** Test-only introspection — never branch production behavior on this. */
export function getVisitEventBatcherStats(): {
  pending: number;
  buckets: number;
  inFlight: number;
} {
  return {
    pending: pendingCount,
    buckets: buckets.size,
    inFlight: inFlight.size
  };
}

/**
 * Test-only: drops BUFFERED records so one test's batch cannot leak into
 * the next. Like `resetVisitorTelemetryQueue`, it cannot cancel a write
 * already IN FLIGHT — a test that needs that must await
 * `flushVisitEventBatches` instead.
 */
export function resetVisitEventBatcher(): void {
  for (const bucket of buckets.values()) {
    clearBucketTimer(bucket);
  }

  buckets.clear();
  pendingCount = 0;
}
