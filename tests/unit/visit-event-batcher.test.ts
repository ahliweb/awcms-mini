/**
 * Unit tests for the per-tenant visitor telemetry batcher (Issue #846,
 * epic #818) — the contracts that need no database.
 *
 * The batcher's SQL behavior (N events = one transaction, partial-batch
 * flush, session sharing, jsonb/occurred_at fidelity) is proven against a
 * real Postgres in `tests/integration/visitor-analytics-batcher.integration.test.ts`.
 * What lives here is what a database would only obscure: backpressure
 * bounds, and the process-lifecycle abstinence that stage 1 already
 * learned the hard way.
 *
 * These tests never trigger a flush, so no record ever reaches the writer
 * and the `sql` handle below is never dereferenced.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildVisitEventRecord } from "../../src/modules/visitor-analytics/application/collector";
import {
  MAX_BATCH_SIZE,
  MAX_PENDING_EVENTS,
  enqueueVisitEvent,
  getVisitEventBatcherStats,
  resetVisitEventBatcher
} from "../../src/modules/visitor-analytics/application/visit-event-batcher";
import { VISITOR_ANALYTICS_DEFAULTS } from "../../src/modules/visitor-analytics/domain/visitor-analytics-config";

/** Never touched: nothing in this file flushes, so no write is ever attempted. */
const SQL = {} as unknown as Bun.SQL;

const CONFIG = {
  ...VISITOR_ANALYTICS_DEFAULTS,
  enabled: true,
  hashSalt: "batcher-unit-salt"
};

function record(visitorKey: string) {
  const built = buildVisitEventRecord({
    correlationId: `corr-${visitorKey}`,
    config: CONFIG,
    method: "GET",
    rawPath: "/pricing",
    statusCode: 200,
    visitorKey,
    ipAddress: null,
    userAgent: null,
    referrerHeader: null,
    isAuthenticated: false,
    identityId: null,
    geo: { countryCode: null, region: null, city: null, timezone: null }
  });

  if (!built) throw new Error("fixture path must be trackable");

  return built;
}

/** Distinct tenants, so no single bucket reaches MAX_BATCH_SIZE and auto-flushes. */
function tenantId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

beforeEach(() => {
  resetVisitEventBatcher();
});

afterEach(() => {
  resetVisitEventBatcher();
});

describe("enqueueVisitEvent — bounded backpressure", () => {
  test("drops new records past MAX_PENDING_EVENTS instead of growing without bound", () => {
    // One record each across many tenants: no bucket hits MAX_BATCH_SIZE, and
    // the linger timers cannot fire inside this synchronous loop, so the
    // buffer genuinely fills.
    for (let index = 0; index < MAX_PENDING_EVENTS; index += 1) {
      enqueueVisitEvent(SQL, tenantId(index), record(`v-${index}`));
    }

    expect(getVisitEventBatcherStats().pending).toBe(MAX_PENDING_EVENTS);

    for (let index = 0; index < 100; index += 1) {
      enqueueVisitEvent(
        SQL,
        tenantId(MAX_PENDING_EVENTS + index),
        record(`overflow-${index}`)
      );
    }

    // Bounded: the overflow was dropped (and counted on
    // visitor_analytics_batch_dropped_total), never retained, and never
    // allowed to evict older records already closer to being written.
    expect(getVisitEventBatcherStats().pending).toBe(MAX_PENDING_EVENTS);
    expect(getVisitEventBatcherStats().buckets).toBe(MAX_PENDING_EVENTS);
  });

  test("is synchronous — it returns void, not an awaitable the caller could re-block on", () => {
    // Same contract, and same rationale, as enqueueVisitorTelemetry's: a
    // stage-1 task must not be able to await the batch write and drag it back
    // toward the response path. Asserted at the TYPE level so a signature
    // change to Promise<void> fails `bun run typecheck` for every caller at
    // once.
    type EnqueueReturn = ReturnType<typeof enqueueVisitEvent>;
    const returnsVoid: EnqueueReturn extends void ? true : false = true;

    expect(returnsVoid).toBe(true);

    enqueueVisitEvent(SQL, tenantId(1), record("void-check"));
    expect(getVisitEventBatcherStats().pending).toBe(1);
  });
});

describe("enqueueVisitEvent — per-tenant grouping", () => {
  test("records for the same tenant share one bucket; different tenants do not", () => {
    enqueueVisitEvent(SQL, tenantId(1), record("a"));
    enqueueVisitEvent(SQL, tenantId(1), record("b"));
    enqueueVisitEvent(SQL, tenantId(2), record("c"));

    // A batch is necessarily per-tenant: withTenant sets one tenant per
    // transaction, so records from two tenants can never share a batch.
    expect(getVisitEventBatcherStats()).toMatchObject({
      pending: 3,
      buckets: 2
    });
  });

  test("a bucket reaching MAX_BATCH_SIZE flushes synchronously at enqueue", () => {
    for (let index = 0; index < MAX_BATCH_SIZE - 1; index += 1) {
      enqueueVisitEvent(SQL, tenantId(1), record(`v-${index}`));
    }

    expect(getVisitEventBatcherStats().pending).toBe(MAX_BATCH_SIZE - 1);

    // The size trigger detaches the records without waiting for the linger,
    // which bounds both the crash window and the size of any one statement.
    // (The write itself then fails open against the dummy handle — that path
    // is exercised for real in the integration suite.)
    enqueueVisitEvent(SQL, tenantId(1), record("trigger"));

    expect(getVisitEventBatcherStats().pending).toBe(0);
  });
});

describe("enqueueVisitEvent — must not touch process lifecycle", () => {
  // Same regression guard as tests/unit/visitor-telemetry-queue.test.ts's.
  // Stage 1 learned this the expensive way: installing SIGTERM handlers from
  // a data-plane call made `process.emit("SIGTERM")` in job-runner.test.ts
  // kill the whole `bun test` runner ~1s in, with either file passing alone.
  // Stage 2 buffers in memory and owns a linger timer, which is exactly the
  // kind of thing that tempts a library into "just flush on exit" — it must
  // not. Shutdown flushing belongs to src/middleware.ts, via
  // flushVisitorTelemetryQueue.
  test("enqueue adds no SIGTERM/SIGINT listener", () => {
    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT")
    };

    enqueueVisitEvent(SQL, tenantId(1), record("a"));
    enqueueVisitEvent(SQL, tenantId(2), record("b"));

    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
  });

  test("a synthetic process.emit('SIGTERM') does not kill this test process", () => {
    // The exact call job-runner.test.ts makes. Reaching the assertion is the
    // proof.
    enqueueVisitEvent(SQL, tenantId(1), record("a"));

    process.emit("SIGTERM");

    expect(true).toBe(true);
  });
});

describe("resetVisitEventBatcher", () => {
  test("drops buffered records and their linger timers", () => {
    enqueueVisitEvent(SQL, tenantId(1), record("a"));
    enqueueVisitEvent(SQL, tenantId(2), record("b"));
    expect(getVisitEventBatcherStats().pending).toBe(2);

    resetVisitEventBatcher();

    // A leftover timer would fire into the NEXT test and try to write one
    // test's records against another's fixtures.
    expect(getVisitEventBatcherStats()).toEqual({
      pending: 0,
      buckets: 0,
      inFlight: 0
    });
  });
});
