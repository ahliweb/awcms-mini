import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  acquireWorkClassSlot,
  getWorkClassSaturation,
  resetWorkClassGatesForTests,
  WorkClassQueueFullError,
  WorkClassTimeoutError
} from "../src/lib/database/work-class";
import {
  createCircuitBreaker,
  getProviderCircuitBreaker,
  resetProviderCircuitBreakersForTests
} from "../src/lib/database/circuit-breaker";

describe("acquireWorkClassSlot", () => {
  beforeEach(() => {
    resetWorkClassGatesForTests();
  });

  afterEach(() => {
    resetWorkClassGatesForTests();
  });

  test("fills up to max concurrently without queueing", async () => {
    // "maintenance" has max 1 (smallest, easiest to exercise deterministically).
    const slot = await acquireWorkClassSlot("maintenance", 50);

    const saturation = getWorkClassSaturation().find(
      (entry) => entry.workClass === "maintenance"
    );

    expect(saturation?.active).toBe(1);
    expect(saturation?.max).toBe(1);
    expect(saturation?.queued).toBe(0);

    slot.release();
  });

  test("queues the next acquire once the class is at max", async () => {
    const first = await acquireWorkClassSlot("maintenance", 200);

    const secondPromise = acquireWorkClassSlot("maintenance", 200);
    // Give the microtask queue a tick so the second acquire has registered
    // as a queued waiter before we assert on saturation.
    await Promise.resolve();

    const saturationWhileQueued = getWorkClassSaturation().find(
      (entry) => entry.workClass === "maintenance"
    );

    expect(saturationWhileQueued?.active).toBe(1);
    expect(saturationWhileQueued?.queued).toBe(1);

    first.release();

    const second = await secondPromise;

    const saturationAfterHandoff = getWorkClassSaturation().find(
      (entry) => entry.workClass === "maintenance"
    );

    expect(saturationAfterHandoff?.active).toBe(1);
    expect(saturationAfterHandoff?.queued).toBe(0);

    second.release();
  });

  test("a release frees a slot for the next queued waiter (FIFO)", async () => {
    const first = await acquireWorkClassSlot("maintenance", 200);
    const order: string[] = [];

    const secondPromise = acquireWorkClassSlot("maintenance", 200).then(
      (slot) => {
        order.push("second");
        return slot;
      }
    );
    const thirdPromise = acquireWorkClassSlot("maintenance", 200).then(
      (slot) => {
        order.push("third");
        return slot;
      }
    );

    await Promise.resolve();
    first.release();

    const second = await secondPromise;
    order.push("second-acquired");
    second.release();

    const third = await thirdPromise;
    order.push("third-acquired");
    third.release();

    expect(order).toEqual([
      "second",
      "second-acquired",
      "third",
      "third-acquired"
    ]);
  });

  test("timeout rejects with WorkClassTimeoutError and clears the queue entry", async () => {
    const first = await acquireWorkClassSlot("maintenance", 200);

    await expect(
      acquireWorkClassSlot("maintenance", 20)
    ).rejects.toBeInstanceOf(WorkClassTimeoutError);

    const saturationAfterTimeout = getWorkClassSaturation().find(
      (entry) => entry.workClass === "maintenance"
    );

    expect(saturationAfterTimeout?.queued).toBe(0);
    expect(saturationAfterTimeout?.active).toBe(1);

    first.release();
  });

  test("getWorkClassSaturation reports max for every work class", () => {
    const saturation = getWorkClassSaturation();
    const byClass = Object.fromEntries(
      saturation.map((entry) => [entry.workClass, entry])
    );

    expect(byClass.critical_transaction?.max).toBe(10);
    expect(byClass.interactive?.max).toBe(8);
    expect(byClass.reporting?.max).toBe(4);
    expect(byClass.background_sync?.max).toBe(4);
    expect(byClass.maintenance?.max).toBe(1);
  });

  // Issue #743 — bounded queue depth = max concurrency x the default
  // DATABASE_WORK_CLASS_QUEUE_MULTIPLIER (4, unset in the test environment).
  test("getWorkClassSaturation reports maxQueueDepth = max x default multiplier (4) for every work class", () => {
    const saturation = getWorkClassSaturation();
    const byClass = Object.fromEntries(
      saturation.map((entry) => [entry.workClass, entry])
    );

    expect(byClass.critical_transaction?.maxQueueDepth).toBe(40);
    expect(byClass.interactive?.maxQueueDepth).toBe(32);
    expect(byClass.reporting?.maxQueueDepth).toBe(16);
    expect(byClass.background_sync?.maxQueueDepth).toBe(16);
    expect(byClass.maintenance?.maxQueueDepth).toBe(4);
  });

  describe("bounded queue depth (Issue #743)", () => {
    // "maintenance" has max 1 -> maxQueueDepth 4 (1 x default multiplier 4) —
    // the smallest, easiest bound to exhaust deterministically in a test.

    test("rejects immediately with WorkClassQueueFullError once the queue is at its bounded cap, without ever waiting", async () => {
      const active = await acquireWorkClassSlot("maintenance", 5_000);
      const queued = [
        acquireWorkClassSlot("maintenance", 5_000),
        acquireWorkClassSlot("maintenance", 5_000),
        acquireWorkClassSlot("maintenance", 5_000),
        acquireWorkClassSlot("maintenance", 5_000)
      ];
      await Promise.resolve();

      const saturationAtCap = getWorkClassSaturation().find(
        (entry) => entry.workClass === "maintenance"
      );
      expect(saturationAtCap?.queued).toBe(4);
      expect(saturationAtCap?.maxQueueDepth).toBe(4);

      // The 6th caller (1 active + 4 queued already) must be rejected
      // OUTRIGHT — this assertion would time out (not just fail fast) if the
      // bounded-queue check were missing, since the promise would otherwise
      // still be pending after `timeoutMs` (5000ms) rather than already
      // rejected.
      let caught: unknown;
      try {
        await acquireWorkClassSlot("maintenance", 5_000);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(WorkClassQueueFullError);
      expect((caught as WorkClassQueueFullError).workClass).toBe("maintenance");
      expect((caught as WorkClassQueueFullError).queueDepth).toBe(4);

      // Queue depth is unaffected by the rejected caller (it never joined).
      const saturationAfterRejection = getWorkClassSaturation().find(
        (entry) => entry.workClass === "maintenance"
      );
      expect(saturationAfterRejection?.queued).toBe(4);

      active.release();
      for (const promise of queued) {
        (await promise).release();
      }
    });

    test("after a release frees room in the queue, a new caller can queue again (not permanently rejecting)", async () => {
      const active = await acquireWorkClassSlot("maintenance", 5_000);
      const first = acquireWorkClassSlot("maintenance", 5_000);
      const second = acquireWorkClassSlot("maintenance", 5_000);
      const third = acquireWorkClassSlot("maintenance", 5_000);
      const fourth = acquireWorkClassSlot("maintenance", 5_000);
      await Promise.resolve();

      // Queue is now at its cap (4) — release the active slot, which hands
      // it directly to the first queued waiter (doc'd releaseSlot
      // behavior), freeing one queue slot.
      active.release();
      const firstSlot = await first;

      const saturationAfterOneHandoff = getWorkClassSaturation().find(
        (entry) => entry.workClass === "maintenance"
      );
      // second/third/fourth are still queued (3), one slot of headroom freed.
      expect(saturationAfterOneHandoff?.queued).toBe(3);

      // A brand-new caller should now be able to join the queue again
      // (queued would become 4, still at/under the cap), not be rejected.
      const fifth = acquireWorkClassSlot("maintenance", 5_000);
      await Promise.resolve();
      const saturationWithFifthQueued = getWorkClassSaturation().find(
        (entry) => entry.workClass === "maintenance"
      );
      expect(saturationWithFifthQueued?.queued).toBe(4);

      firstSlot.release();
      (await second).release();
      (await third).release();
      (await fourth).release();
      (await fifth).release();
    });

    test("WorkClassQueueFullError and WorkClassTimeoutError are distinct classes (callers can tell 'rejected outright' from 'waited then timed out')", async () => {
      expect(Object.is(WorkClassQueueFullError, WorkClassTimeoutError)).toBe(
        false
      );

      const error = new WorkClassQueueFullError("maintenance", 4);
      expect(error).not.toBeInstanceOf(WorkClassTimeoutError);
      expect(error.name).toBe("WorkClassQueueFullError");
    });
  });
});

describe("createCircuitBreaker", () => {
  test("stays closed below the failure threshold", () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);
    breaker.recordFailure(t0);

    expect(breaker.getState(t0)).toBe("closed");
    expect(breaker.canAttempt(t0)).toBe(true);
  });

  test("opens after consecutive failures reach the threshold", () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);
    breaker.recordFailure(t0);
    breaker.recordFailure(t0);

    expect(breaker.getState(t0)).toBe("open");
    expect(breaker.canAttempt(t0)).toBe(false);
  });

  test("a success resets the consecutive failure count", () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);
    breaker.recordFailure(t0);
    breaker.recordSuccess(t0);
    breaker.recordFailure(t0);
    breaker.recordFailure(t0);

    expect(breaker.getState(t0)).toBe("closed");
  });

  test("stays open before openDurationMs elapses", () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);

    const beforeElapsed = new Date(t0.getTime() + 999);

    expect(breaker.getState(beforeElapsed)).toBe("open");
    expect(breaker.canAttempt(beforeElapsed)).toBe(false);
  });

  test("allows exactly one trial call after openDurationMs elapses (half-open)", () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);

    const afterElapsed = new Date(t0.getTime() + 1000);

    expect(breaker.getState(afterElapsed)).toBe("half_open");
    expect(breaker.canAttempt(afterElapsed)).toBe(true);
  });

  test("half-open success closes the breaker", () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);

    const afterElapsed = new Date(t0.getTime() + 1000);

    expect(breaker.getState(afterElapsed)).toBe("half_open");
    breaker.recordSuccess(afterElapsed);

    expect(breaker.getState(afterElapsed)).toBe("closed");
  });

  test("half-open failure reopens the breaker and resets the open-since timer", () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);

    const afterElapsed = new Date(t0.getTime() + 1000);

    expect(breaker.getState(afterElapsed)).toBe("half_open");
    breaker.recordFailure(afterElapsed);
    expect(breaker.getState(afterElapsed)).toBe("open");

    // The open window restarted at `afterElapsed`, so 999ms later it should
    // still be open (not already eligible for another half-open trial based
    // on the original t0 timestamp).
    const almostElapsedAgain = new Date(afterElapsed.getTime() + 999);

    expect(breaker.getState(almostElapsedAgain)).toBe("open");

    const elapsedAgain = new Date(afterElapsed.getTime() + 1000);

    expect(breaker.getState(elapsedAgain)).toBe("half_open");
  });
});

// Issue #436 — extends the same generic circuit breaker (above) to outbound
// calls to external providers (object storage upload dispatcher), via a
// per-provider-key registry rather than a single DB-only singleton.
describe("getProviderCircuitBreaker", () => {
  afterEach(() => {
    resetProviderCircuitBreakersForTests();
  });

  test("returns the same breaker instance for the same provider key", () => {
    const first = getProviderCircuitBreaker("object-storage", {
      failureThreshold: 3,
      openDurationMs: 1000
    });
    const second = getProviderCircuitBreaker("object-storage");

    const t0 = new Date("2026-01-01T00:00:00.000Z");
    first.recordFailure(t0);
    first.recordFailure(t0);
    first.recordFailure(t0);

    expect(second.getState(t0)).toBe("open");
  });

  test("keeps separate state for different provider keys", () => {
    const objectStorage = getProviderCircuitBreaker("object-storage", {
      failureThreshold: 2,
      openDurationMs: 1000
    });
    const otherProvider = getProviderCircuitBreaker("other-provider", {
      failureThreshold: 2,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    objectStorage.recordFailure(t0);
    objectStorage.recordFailure(t0);

    expect(objectStorage.getState(t0)).toBe("open");
    expect(otherProvider.getState(t0)).toBe("closed");
  });

  test("resetProviderCircuitBreakersForTests clears all registered breakers", () => {
    const breaker = getProviderCircuitBreaker("object-storage", {
      failureThreshold: 1,
      openDurationMs: 1000
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    breaker.recordFailure(t0);
    expect(breaker.getState(t0)).toBe("open");

    resetProviderCircuitBreakersForTests();

    const fresh = getProviderCircuitBreaker("object-storage", {
      failureThreshold: 1,
      openDurationMs: 1000
    });
    expect(fresh.getState(t0)).toBe("closed");
  });
});
