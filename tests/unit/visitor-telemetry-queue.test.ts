/**
 * Unit tests for the visitor telemetry queue (Issue #832, epic #818).
 *
 * `src/middleware.ts` itself is not importable under `bun test` (it imports
 * the `astro:middleware` virtual module — see that file's own note), so the
 * middleware's non-blocking behavior is proven here, at the seam it now
 * delegates to: if `enqueueVisitorTelemetry` returns before the task has
 * run, the response cannot be waiting on it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MAX_QUEUE_DEPTH,
  enqueueVisitorTelemetry,
  flushVisitorTelemetryQueue,
  getVisitorTelemetryQueueStats,
  resetVisitorTelemetryQueue
} from "../../src/modules/visitor-analytics/application/telemetry-queue";

beforeEach(() => {
  resetVisitorTelemetryQueue();
});

afterEach(async () => {
  await flushVisitorTelemetryQueue(500);
  resetVisitorTelemetryQueue();
});

describe("enqueueVisitorTelemetry — never blocks the caller", () => {
  test("returns before a slow task has finished (this is the TTFB fix)", async () => {
    let finished = false;

    enqueueVisitorTelemetry(async () => {
      await Bun.sleep(50);
      finished = true;
    });

    // The whole point of the issue: the middleware reaches this line — i.e.
    // returns the response — while the telemetry write is still running.
    expect(finished).toBe(false);

    await flushVisitorTelemetryQueue();

    expect(finished).toBe(true);
  });

  test("is synchronous — it returns void, not an awaitable the caller could re-block on", () => {
    const returned = enqueueVisitorTelemetry(async () => {});

    expect(returned).toBeUndefined();
  });
});

describe("flushVisitorTelemetryQueue — no event loss on normal shutdown", () => {
  test("every queued event runs before flush resolves", async () => {
    const completed: number[] = [];

    for (let index = 0; index < 25; index += 1) {
      enqueueVisitorTelemetry(async () => {
        await Bun.sleep(1);
        completed.push(index);
      });
    }

    await flushVisitorTelemetryQueue();

    // Acceptance criterion (c): nothing pending, nothing in flight, and
    // every single event actually written — not merely "the queue drained".
    expect(completed).toHaveLength(25);
    expect(getVisitorTelemetryQueueStats()).toEqual({ queued: 0, inFlight: 0 });
  });

  test("flushing an already-idle queue resolves immediately and is safe to repeat", async () => {
    await flushVisitorTelemetryQueue();
    await flushVisitorTelemetryQueue();

    expect(getVisitorTelemetryQueueStats()).toEqual({ queued: 0, inFlight: 0 });
  });

  test("a task enqueued while a flush is draining is still flushed", async () => {
    const completed: string[] = [];

    enqueueVisitorTelemetry(async () => {
      await Bun.sleep(10);
      completed.push("first");
      enqueueVisitorTelemetry(async () => {
        completed.push("second");
      });
    });

    await flushVisitorTelemetryQueue();

    expect(completed).toEqual(["first", "second"]);
  });

  test("flush gives up after its timeout rather than hanging shutdown forever", async () => {
    // The slow task is deliberately only 400ms, not "effectively forever":
    // `resetVisitorTelemetryQueue()` can drop PENDING work but cannot
    // cancel work already IN FLIGHT, so a task outliving this test would
    // still be occupying a drain slot during the next one — which is
    // exactly how an earlier draft of this file made the following test
    // fail for a reason that had nothing to do with it. 400ms is far longer
    // than the 40ms flush budget below (so the timeout is what's proven),
    // and short enough that `afterEach`'s own flush reaps it.
    enqueueVisitorTelemetry(async () => {
      await Bun.sleep(400);
    });

    const startedAt = performance.now();
    await flushVisitorTelemetryQueue(40);
    const elapsed = performance.now() - startedAt;

    // A hung database must not hold the process open indefinitely — the
    // remaining events are lost, loudly (logged), which is the documented
    // trade rather than an unbounded shutdown.
    expect(elapsed).toBeLessThan(250);
  });
});

describe("enqueueVisitorTelemetry — fail-open is really fail-open", () => {
  test("a throwing task never escapes as an unhandled rejection and never stops the queue", async () => {
    const completed: string[] = [];

    enqueueVisitorTelemetry(async () => {
      throw new Error("database exploded");
    });
    enqueueVisitorTelemetry(async () => {
      completed.push("after-the-failure");
    });

    await flushVisitorTelemetryQueue();

    // An escaping rejection would kill the process; a queue that stops
    // draining after one failure would silently lose all later telemetry.
    expect(completed).toEqual(["after-the-failure"]);
    expect(getVisitorTelemetryQueueStats()).toEqual({ queued: 0, inFlight: 0 });
  });
});

describe("enqueueVisitorTelemetry — bounded backpressure", () => {
  test("drops new events past MAX_QUEUE_DEPTH instead of growing without bound", async () => {
    let executed = 0;

    // Block the drain so the queue genuinely fills up.
    enqueueVisitorTelemetry(async () => {
      await Bun.sleep(200);
    });
    enqueueVisitorTelemetry(async () => {
      await Bun.sleep(200);
    });

    for (let index = 0; index < MAX_QUEUE_DEPTH + 100; index += 1) {
      enqueueVisitorTelemetry(async () => {
        executed += 1;
      });
    }

    expect(getVisitorTelemetryQueueStats().queued).toBeLessThanOrEqual(
      MAX_QUEUE_DEPTH
    );

    await flushVisitorTelemetryQueue(3_000);

    // Bounded: the overflow was dropped (and counted on
    // visitor_analytics_queue_dropped_total), not retained.
    expect(executed).toBeLessThanOrEqual(MAX_QUEUE_DEPTH);
    expect(executed).toBeGreaterThan(0);
  });
});
