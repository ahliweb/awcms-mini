/**
 * Issue #840 — unit-level pin for `verifyPasswordOrDummy`, the helper that
 * stops `POST /auth/login` from answering an unknown `loginIdentifier` ~19x
 * faster than a known one (measured 4.13 ms vs 80.13 ms) by skipping argon2id
 * entirely.
 *
 * The integration test asserts the property end-to-end through the HTTP
 * handler; this file pins the helper's own contract, which is what a future
 * refactor is most likely to break quietly.
 */
import { describe, expect, test } from "bun:test";

import {
  hashPassword,
  verifyPasswordOrDummy
} from "../../src/lib/auth/password";

const PASSWORD = "unit-test-password";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("verifyPasswordOrDummy (Issue #840)", () => {
  test("returns true only for the correct password against a real hash", async () => {
    const hash = await hashPassword(PASSWORD);

    // Both sides asserted: a helper hardcoded to `false` would close the
    // timing oracle and silently break every login.
    expect(await verifyPasswordOrDummy(PASSWORD, hash)).toBe(true);
    expect(await verifyPasswordOrDummy("wrong-password", hash)).toBe(false);
  });

  test("returns false for a null hash", async () => {
    expect(await verifyPasswordOrDummy(PASSWORD, null)).toBe(false);
    expect(await verifyPasswordOrDummy("", null)).toBe(false);
  });

  test("still spends argon2id work when the hash is null", async () => {
    // Warm the memoized dummy hash first, so this measures the steady-state
    // cost the login handler actually pays — not the one-time hash.
    await verifyPasswordOrDummy(PASSWORD, null);

    const realHash = await hashPassword(PASSWORD);
    const nullTimes: number[] = [];
    const realTimes: number[] = [];

    for (let round = 0; round < 5; round += 1) {
      let startedAt = performance.now();
      await verifyPasswordOrDummy(PASSWORD, null);
      nullTimes.push(performance.now() - startedAt);

      startedAt = performance.now();
      await verifyPasswordOrDummy("wrong-password", realHash);
      realTimes.push(performance.now() - startedAt);
    }

    const nullMedian = median(nullTimes);
    const realMedian = median(realTimes);

    // The whole point: the null-hash path must NOT be the cheap path. A plain
    // `return false` would put this ratio at ~0.
    expect(nullMedian / realMedian).toBeGreaterThan(0.5);

    // Non-vacuous: a real argon2id verify cannot finish in under a
    // millisecond, so this fails if both paths became trivially fast.
    expect(nullMedian).toBeGreaterThan(1);
    expect(realMedian).toBeGreaterThan(1);
  }, 60_000);

  // Mutation-verified (Issue #840). Two deliberate breaks of
  // `verifyPasswordOrDummy` were confirmed to turn the timing test above red:
  //   1. `if (hash === null) return false;` — skipping the dummy verify.
  //   2. building the dummy with `memoryCost: 4, timeCost: 1` instead of via
  //      `hashPassword` — cheap parameters restore the gap even though
  //      argon2id still "runs", which is exactly why the dummy is produced by
  //      `hashPassword` itself rather than by a pinned literal.
  // Both are the realistic regressions here, and neither is visible to
  // typecheck.
});
