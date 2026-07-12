/**
 * Issue #698 (epic #679, "operational proof" wave) — proves
 * `acquireWorkClassSlot`/slot release mirror `gates[workClass]`'s
 * active/queued counts into `db_pool_work_class_active`/
 * `db_pool_work_class_queued` gauges, without changing
 * `getWorkClassSaturation`'s own existing behavior (covered separately by
 * `tests/database-pooling.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  acquireWorkClassSlot,
  resetWorkClassGatesForTests
} from "../../src/lib/database/work-class";
import { createInMemoryMetricsPort } from "../../src/lib/observability/in-memory-metrics-port";
import {
  resetMetricsPortForTests,
  setMetricsPort
} from "../../src/lib/observability/metrics-port";

describe("work-class pool gauges (Issue #698)", () => {
  beforeEach(() => {
    resetWorkClassGatesForTests();
  });

  afterEach(() => {
    resetWorkClassGatesForTests();
    resetMetricsPortForTests();
  });

  test("acquiring a slot sets db_pool_work_class_active to the new active count", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);

    const slot = await acquireWorkClassSlot("maintenance", 50);

    expect(
      port.getSnapshot().gauges[
        "db_pool_work_class_active{workClass=maintenance}"
      ]
    ).toBe(1);
    expect(
      port.getSnapshot().gauges[
        "db_pool_work_class_queued{workClass=maintenance}"
      ]
    ).toBe(0);

    slot.release();
  });

  test("releasing a slot brings db_pool_work_class_active back down", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);

    const slot = await acquireWorkClassSlot("maintenance", 50);
    slot.release();

    expect(
      port.getSnapshot().gauges[
        "db_pool_work_class_active{workClass=maintenance}"
      ]
    ).toBe(0);
  });

  test("a queued waiter is reflected in db_pool_work_class_queued", async () => {
    const port = createInMemoryMetricsPort();
    setMetricsPort(port);

    const first = await acquireWorkClassSlot("maintenance", 200);
    const secondPromise = acquireWorkClassSlot("maintenance", 200);
    await Promise.resolve();

    expect(
      port.getSnapshot().gauges[
        "db_pool_work_class_queued{workClass=maintenance}"
      ]
    ).toBe(1);

    first.release();
    const second = await secondPromise;
    second.release();
  });
});
