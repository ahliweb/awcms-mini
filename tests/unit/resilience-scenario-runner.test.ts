/**
 * Unit tests for the generic DR/chaos scenario harness (Issue #699, epic
 * #679) — deterministic timeout enforcement and the tri-state overall
 * aggregation rule, without any real scenario/DB/network involved.
 */
import { describe, expect, test } from "bun:test";

import {
  computeDrOverall,
  runScenario,
  type ScenarioContext,
  type ScenarioResult
} from "../../src/lib/resilience/scenario-runner";

const ctx: ScenarioContext = { databaseUrl: "unused", env: {} };

function fakeResult(
  status: ScenarioResult["status"],
  name = "fake"
): ScenarioResult {
  return { name, tier: "safe", status, detail: "", durationMs: 0, metrics: {} };
}

describe("runScenario", () => {
  test("a scenario that resolves ok:true becomes status 'pass'", async () => {
    const result = await runScenario(
      {
        name: "always-pass",
        tier: "safe",
        timeoutMs: 1_000,
        run: async () => ({ ok: true, detail: "fine" })
      },
      ctx
    );

    expect(result.status).toBe("pass");
    expect(result.detail).toBe("fine");
  });

  test("a scenario that resolves ok:false becomes status 'fail'", async () => {
    const result = await runScenario(
      {
        name: "always-fail",
        tier: "safe",
        timeoutMs: 1_000,
        run: async () => ({ ok: false, detail: "broken" })
      },
      ctx
    );

    expect(result.status).toBe("fail");
    expect(result.detail).toBe("broken");
  });

  test("a scenario that resolves skipped:true becomes status 'skipped' regardless of ok", async () => {
    const result = await runScenario(
      {
        name: "environment-constrained",
        tier: "full",
        timeoutMs: 1_000,
        run: async () => ({
          ok: true,
          skipped: true,
          detail: "no compatible tooling"
        })
      },
      ctx
    );

    expect(result.status).toBe("skipped");
  });

  test("a scenario that throws becomes status 'fail' with the error message as detail", async () => {
    const result = await runScenario(
      {
        name: "throws",
        tier: "safe",
        timeoutMs: 1_000,
        run: async () => {
          throw new Error("boom");
        }
      },
      ctx
    );

    expect(result.status).toBe("fail");
    expect(result.detail).toBe("boom");
  });

  test("a scenario that never resolves is bounded by its own timeoutMs and reported as 'fail'", async () => {
    const result = await runScenario(
      {
        name: "hangs-forever",
        tier: "safe",
        timeoutMs: 50,
        run: () => new Promise(() => {})
      },
      ctx
    );

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("timeout");
    expect(result.durationMs).toBeLessThan(1_000);
  });

  test("metrics are passed through on a passing result", async () => {
    const result = await runScenario(
      {
        name: "with-metrics",
        tier: "safe",
        timeoutMs: 1_000,
        run: async () => ({
          ok: true,
          detail: "ok",
          metrics: { rtoMs: 42 }
        })
      },
      ctx
    );

    expect(result.metrics).toEqual({ rtoMs: 42 });
  });
});

describe("computeDrOverall", () => {
  test("all pass -> 'pass'", () => {
    expect(computeDrOverall([fakeResult("pass"), fakeResult("pass")])).toBe(
      "pass"
    );
  });

  test("any fail -> 'fail', even alongside passes and skips", () => {
    expect(
      computeDrOverall([
        fakeResult("pass"),
        fakeResult("skipped"),
        fakeResult("fail")
      ])
    ).toBe("fail");
  });

  test("a skip with no fail -> 'incomplete', never silently 'pass'", () => {
    expect(computeDrOverall([fakeResult("pass"), fakeResult("skipped")])).toBe(
      "incomplete"
    );
  });

  test("empty result set -> 'pass' (vacuously — every() on an empty array is true)", () => {
    expect(computeDrOverall([])).toBe("pass");
  });
});
