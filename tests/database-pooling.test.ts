import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  acquireWorkClassSlot,
  getWorkClassSaturation,
  resetWorkClassGatesForTests,
  WorkClassTimeoutError
} from "../src/lib/database/work-class";
import { createCircuitBreaker } from "../src/lib/database/circuit-breaker";

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
