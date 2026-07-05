import { describe, expect, test } from "bun:test";

import { permissionKey } from "../src/modules/identity-access/domain/access-control";
import { shapeSyncHealth } from "../src/modules/reporting/domain/sync-health";

describe("permissionKey — reporting dashboard guard", () => {
  test("builds the single shared permission key used by all four GET /reports/* endpoints", () => {
    expect(permissionKey("reporting", "dashboard", "read")).toBe(
      "reporting.dashboard.read"
    );
  });
});

describe("shapeSyncHealth", () => {
  test("healthy: at least one active node, no open conflicts, no failed objects", () => {
    const view = shapeSyncHealth({
      totalNodeCount: 2,
      activeNodeCount: 2,
      openConflictCount: 0,
      pendingObjectCount: 3,
      failedObjectCount: 0
    });

    expect(view).toMatchObject({
      hasOpenConflicts: false,
      hasFailedObjects: false,
      isHealthy: true
    });
  });

  test("unhealthy: zero registered nodes even with no conflicts/failures", () => {
    const view = shapeSyncHealth({
      totalNodeCount: 0,
      activeNodeCount: 0,
      openConflictCount: 0,
      pendingObjectCount: 0,
      failedObjectCount: 0
    });

    expect(view.hasOpenConflicts).toBe(false);
    expect(view.hasFailedObjects).toBe(false);
    expect(view.isHealthy).toBe(false);
  });

  test("unhealthy: an open conflict flips isHealthy to false even with active nodes", () => {
    const view = shapeSyncHealth({
      totalNodeCount: 1,
      activeNodeCount: 1,
      openConflictCount: 1,
      pendingObjectCount: 0,
      failedObjectCount: 0
    });

    expect(view.hasOpenConflicts).toBe(true);
    expect(view.hasFailedObjects).toBe(false);
    expect(view.isHealthy).toBe(false);
  });

  test("unhealthy: a failed object-sync-queue entry flips isHealthy to false even with active nodes", () => {
    const view = shapeSyncHealth({
      totalNodeCount: 1,
      activeNodeCount: 1,
      openConflictCount: 0,
      pendingObjectCount: 0,
      failedObjectCount: 1
    });

    expect(view.hasOpenConflicts).toBe(false);
    expect(view.hasFailedObjects).toBe(true);
    expect(view.isHealthy).toBe(false);
  });

  test("passes counts through unchanged", () => {
    const view = shapeSyncHealth({
      totalNodeCount: 5,
      activeNodeCount: 3,
      openConflictCount: 2,
      pendingObjectCount: 7,
      failedObjectCount: 4
    });

    expect(view.totalNodeCount).toBe(5);
    expect(view.activeNodeCount).toBe(3);
    expect(view.openConflictCount).toBe(2);
    expect(view.pendingObjectCount).toBe(7);
    expect(view.failedObjectCount).toBe(4);
  });
});
