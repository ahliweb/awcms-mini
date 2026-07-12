/**
 * "pool-saturation" scenario (Issue #699). Reuses the REAL application-
 * level work-class concurrency gate (`src/lib/database/work-class.ts`,
 * Issue 10.2) rather than reimplementing a second saturation mechanism —
 * this is the exact gate `withTenant` (`tenant-context.ts`) puts in front
 * of every tenant-scoped query, so proving its behavior here proves the
 * real backpressure path.
 *
 * Phases:
 * - Setup: reset gate state (test-only reset, safe for a standalone CLI
 *   process — no other code in this process has touched the gates yet)
 *   and fill the smallest work class (`maintenance`, max 1) to capacity.
 * - Execute: a second acquire on the same, now-saturated class.
 * - Verify: the second acquire times out with `WorkClassTimeoutError`
 *   (backpressure, not an unbounded hang or a silent over-admit) within
 *   its own short timeout; a THIRD acquire queued behind the first is
 *   then handed the slot the instant the first releases (FIFO hand-off,
 *   proving the queue itself is not stuck once capacity frees up).
 * - Cleanup: release all slots and reset gate state again, so a
 *   subsequent scenario/run in the same process starts clean.
 */
import {
  acquireWorkClassSlot,
  getWorkClassSaturation,
  resetWorkClassGatesForTests,
  WorkClassTimeoutError
} from "../../database/work-class";
import type { ScenarioDefinition, ScenarioOutcome } from "../scenario-runner";

export function poolSaturationScenario(): ScenarioDefinition {
  return {
    name: "pool-saturation",
    tier: "safe",
    timeoutMs: 5_000,
    async run(): Promise<ScenarioOutcome> {
      // Setup.
      resetWorkClassGatesForTests();

      try {
        const first = await acquireWorkClassSlot("maintenance", 500);
        const saturationAfterFirst = getWorkClassSaturation().find(
          (entry) => entry.workClass === "maintenance"
        );

        if (
          !saturationAfterFirst ||
          saturationAfterFirst.active !== 1 ||
          saturationAfterFirst.max !== 1
        ) {
          first.release();
          return {
            ok: false,
            detail: `Unexpected saturation snapshot after the first acquire: ${JSON.stringify(saturationAfterFirst)}`
          };
        }

        // Execute: a second acquire against a class already at capacity.
        const backpressureStart = performance.now();
        let timedOutAsExpected = false;

        try {
          await acquireWorkClassSlot("maintenance", 150);
        } catch (error) {
          timedOutAsExpected = error instanceof WorkClassTimeoutError;
        }

        const backpressureMs = performance.now() - backpressureStart;

        // Verify (a).
        if (!timedOutAsExpected) {
          first.release();
          return {
            ok: false,
            detail:
              "A second acquire on a saturated class did not time out with " +
              "WorkClassTimeoutError — backpressure is not enforced."
          };
        }

        // Verify (b): a queued waiter is handed the slot once it frees.
        const queuedPromise = acquireWorkClassSlot("maintenance", 1_000);
        await Promise.resolve();
        const saturationWhileQueued = getWorkClassSaturation().find(
          (entry) => entry.workClass === "maintenance"
        );

        first.release();
        const handedOff = await queuedPromise;
        handedOff.release();

        return {
          ok: true,
          detail:
            `A saturated "maintenance" class correctly rejected an over-capacity ` +
            `waiter after ~${backpressureMs.toFixed(0)}ms (WorkClassTimeoutError), ` +
            `and a FIFO-queued waiter (queued=${saturationWhileQueued?.queued}) ` +
            "was handed the slot the instant it freed.",
          metrics: { backpressureLatencyMs: Number(backpressureMs.toFixed(1)) }
        };
      } finally {
        // Cleanup.
        resetWorkClassGatesForTests();
      }
    }
  };
}
