import { describe, expect, test } from "bun:test";

import { acquireAdvisoryLock } from "../../src/lib/jobs/advisory-lock";
import {
  applyJobExitCode,
  isJobResultOk,
  parseJobCliArgs,
  runJob,
  type JobDefinition
} from "../../src/lib/jobs/job-runner";

/**
 * A fake `Bun.SQL` whose ONLY implemented capability is `.reserve()` +
 * enough tagged-template pattern matching to answer
 * `pg_try_advisory_lock`/`pg_advisory_unlock` the same way a real Postgres
 * session would — backed by an in-process `Map` instead of an actual
 * session/connection. This is enough to exercise every control-flow path in
 * `runJob` (skip-on-contention, success, partial, error, timeout,
 * termination) deterministically and without a database; the REAL
 * Postgres locking semantics (genuine concurrent connections truly
 * contending for the same session-level lock) are covered separately by
 * `tests/integration/job-runner.integration.test.ts`.
 */
function createFakeLockSql(): Bun.SQL {
  const held = new Set<string>();

  function makeReserved() {
    const reservedFn = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const text = strings.join("");
      const lockKey = `${values[0]}:${values[1]}`;

      if (text.includes("pg_try_advisory_lock")) {
        if (held.has(lockKey)) {
          return [{ acquired: false }];
        }
        held.add(lockKey);
        return [{ acquired: true }];
      }

      if (text.includes("pg_advisory_unlock")) {
        held.delete(lockKey);
        return [{ released: true }];
      }

      return [];
    }) as unknown as Bun.SQL;
    (reservedFn as unknown as { release: () => void }).release = () => {};
    return reservedFn;
  }

  return {
    reserve: async () => makeReserved()
  } as unknown as Bun.SQL;
}

function definition(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    name: "test:job",
    description: "A test job.",
    handler: async () => ({ status: "success" as const }),
    ...overrides
  };
}

describe("runJob (Issue #697)", () => {
  test("a successful handler produces status: success with its item counts", async () => {
    const sql = createFakeLockSql();
    const result = await runJob(
      definition({
        handler: async () => ({ itemCounts: { purged: 5 } })
      }),
      { sql }
    );

    expect(result.status).toBe("success");
    expect(result.itemCounts).toEqual({ purged: 5 });
    expect(isJobResultOk(result)).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(result.correlationId).toBeTruthy();
  });

  test("a handler reporting status: partial is surfaced as partial (non-ok)", async () => {
    const sql = createFakeLockSql();
    const result = await runJob(
      definition({
        handler: async () => ({
          status: "partial" as const,
          itemCounts: { failed: 2 }
        })
      }),
      { sql }
    );

    expect(result.status).toBe("partial");
    expect(isJobResultOk(result)).toBe(false);
  });

  test("a thrown handler error produces status: failed with a sanitized error, AND releases the lock (proven by a following run succeeding)", async () => {
    const sql = createFakeLockSql();
    const boom = new Error("db write failed, password=hunter2-fabricated");

    const failed = await runJob(
      definition({
        name: "test:job:error-release",
        handler: async () => {
          throw boom;
        }
      }),
      { sql }
    );

    expect(failed.status).toBe("failed");
    expect(failed.error).toBeDefined();
    expect(failed.error!.message).not.toContain("hunter2-fabricated");
    expect(failed.error!.message).toContain("[REDACTED]");

    // Proof the lock was released on the error path, not just assumed:
    // a second run for the SAME job name against the SAME fake session
    // store must be able to acquire the lock again immediately.
    const secondRun = await runJob(
      definition({
        name: "test:job:error-release",
        handler: async () => ({ itemCounts: { ok: 1 } })
      }),
      { sql }
    );

    expect(secondRun.status).toBe("success");
  });

  test("skips (does not run the handler) when another instance already holds the lock, and never runs both concurrently", async () => {
    const sql = createFakeLockSql();
    const jobName = "test:job:contention";
    let handlerRan = false;

    // Simulate "another instance" by acquiring the lock directly first.
    const externalHolder = await acquireAdvisoryLock(sql, jobName);
    expect(externalHolder).not.toBeNull();

    const skipped = await runJob(
      definition({
        name: jobName,
        handler: async () => {
          handlerRan = true;
          return {};
        }
      }),
      { sql }
    );

    expect(skipped.status).toBe("skipped");
    expect(handlerRan).toBe(false);
    expect(isJobResultOk(skipped)).toBe(true);

    // Release the external holder, then confirm the SAME job can run now.
    await externalHolder!.release();

    const afterRelease = await runJob(
      definition({
        name: jobName,
        handler: async () => {
          handlerRan = true;
          return {};
        }
      }),
      { sql }
    );

    expect(afterRelease.status).toBe("success");
    expect(handlerRan).toBe(true);
  });

  test("PR #713 fix (security-auditor High finding): a handler that never resolves is cut off by timeoutMs -> status: timeout, but the lock STAYS held (an immediate retry is skipped, NOT allowed to run overlapping the still-running first handler) until the grace period elapses", async () => {
    const sql = createFakeLockSql();
    const jobName = "test:job:timeout-release";

    const timedOut = await runJob(
      definition({
        name: jobName,
        timeoutMs: 25,
        lockReleaseGraceMs: 80,
        handler: () => new Promise(() => {}) // never resolves, never checks signal
      }),
      { sql }
    );

    expect(timedOut.status).toBe("timeout");
    expect(timedOut.detail).toContain("timeout");
    expect(isJobResultOk(timedOut)).toBe(false);

    // THE CORE REGRESSION PROOF: immediately after runJob's own promise
    // resolved, the first handler is still (forever) "running" — a second
    // attempt for the SAME job name must be rejected/skipped, not allowed
    // to start a genuinely overlapping execution. The pre-fix
    // implementation released the lock synchronously here, so this
    // assertion would have failed (gotten "success") before the fix.
    const immediateRetry = await runJob(
      definition({
        name: jobName,
        handler: async () => ({ itemCounts: { ok: 1 } })
      }),
      { sql }
    );
    expect(immediateRetry.status).toBe("skipped");

    // Once the (short, test-only) grace period has elapsed, the detached
    // background continuation releases the lock even though this
    // handler never itself settled — bounding the worst case.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const afterGrace = await runJob(
      definition({
        name: jobName,
        handler: async () => ({ itemCounts: { ok: 1 } })
      }),
      { sql }
    );
    expect(afterGrace.status).toBe("success");
  });

  test("PR #713 fix: if the handler settles (cooperatively) shortly after the abort fires, the lock releases as soon as it settles — NOT the full grace period", async () => {
    const sql = createFakeLockSql();
    const jobName = "test:job:cooperative-release";
    let handlerSettled = false;

    const timedOut = await runJob(
      definition({
        name: jobName,
        timeoutMs: 20,
        lockReleaseGraceMs: 5_000, // deliberately large — must NOT need to wait this long
        handler: (ctx) =>
          new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              setTimeout(() => {
                handlerSettled = true;
                resolve();
              }, 30); // simulates a brief, cooperative wind-down after noticing the abort
            });
          })
      }),
      { sql }
    );

    expect(timedOut.status).toBe("timeout");

    // Poll for the lock to free up. It must do so shortly after the
    // handler's own ~30ms wind-down, nowhere near the 5000ms grace bound —
    // proving "whichever comes first" (handler settling vs. grace elapsing).
    const pollStart = Date.now();
    let acquiredAt = -1;
    while (Date.now() - pollStart < 2_000) {
      const attempt = await runJob(
        definition({ name: jobName, handler: async () => ({}) }),
        { sql }
      );
      if (attempt.status === "success") {
        acquiredAt = Date.now();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(acquiredAt).toBeGreaterThan(0);
    expect(handlerSettled).toBe(true);
    expect(acquiredAt - pollStart).toBeLessThan(1_000);
  });

  test("SIGTERM during a run produces status: terminated; the lock stays held (immediate retry skipped) until the grace period elapses — not just the happy path", async () => {
    const sql = createFakeLockSql();
    const jobName = "test:job:sigterm-release";

    const runPromise = runJob(
      definition({
        name: jobName,
        timeoutMs: 60_000,
        lockReleaseGraceMs: 80,
        handler: () => new Promise(() => {}) // never resolves on its own, ignores signal
      }),
      { sql }
    );

    // Give runJob a tick to acquire the lock and register its signal
    // handler before we simulate termination.
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit("SIGTERM");

    const terminated = await runPromise;
    expect(terminated.status).toBe("terminated");
    expect(terminated.detail).toContain("SIGTERM");
    expect(isJobResultOk(terminated)).toBe(false);

    // Immediately after: the first handler is still (forever) "running" —
    // a second attempt must be rejected/skipped, proving the lock did not
    // release the instant runJob's own promise resolved.
    const immediateRetry = await runJob(
      definition({
        name: jobName,
        handler: async () => ({ itemCounts: { ok: 1 } })
      }),
      { sql }
    );
    expect(immediateRetry.status).toBe("skipped");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const afterGrace = await runJob(
      definition({
        name: jobName,
        handler: async () => ({ itemCounts: { ok: 1 } })
      }),
      { sql }
    );
    expect(afterGrace.status).toBe("success");
  });

  test("SIGINT is also treated as a graceful termination signal", async () => {
    const sql = createFakeLockSql();
    const jobName = "test:job:sigint-release";

    const runPromise = runJob(
      definition({
        name: jobName,
        timeoutMs: 60_000,
        lockReleaseGraceMs: 50,
        handler: () => new Promise(() => {})
      }),
      { sql }
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit("SIGINT");

    const terminated = await runPromise;
    expect(terminated.status).toBe("terminated");
    expect(terminated.detail).toContain("SIGINT");
  });

  test("dryRun is threaded through into the job context and the result", async () => {
    const sql = createFakeLockSql();
    let sawDryRun: boolean | undefined;

    const result = await runJob(
      definition({
        name: "test:job:dry-run",
        handler: async (ctx) => {
          sawDryRun = ctx.dryRun;
          return {};
        }
      }),
      { sql, dryRun: true }
    );

    expect(sawDryRun).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  test("a caller-supplied correlationId is passed through unchanged", async () => {
    const sql = createFakeLockSql();
    const result = await runJob(definition({ name: "test:job:correlation" }), {
      sql,
      correlationId: "11111111-1111-1111-1111-111111111111"
    });

    expect(result.correlationId).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("applyJobExitCode (Issue #697)", () => {
  test("does not set a nonzero exit code for success/skipped", () => {
    process.exitCode = 0;
    applyJobExitCode({
      jobName: "x",
      runId: "x",
      correlationId: "x",
      status: "success",
      startedAt: "",
      finishedAt: "",
      durationMs: 0,
      dryRun: false
    });
    expect(process.exitCode).toBe(0);

    applyJobExitCode({
      jobName: "x",
      runId: "x",
      correlationId: "x",
      status: "skipped",
      startedAt: "",
      finishedAt: "",
      durationMs: 0,
      dryRun: false
    });
    expect(process.exitCode).toBe(0);
  });

  test("sets exit code 1 for failed/partial/timeout/terminated", () => {
    for (const status of [
      "failed",
      "partial",
      "timeout",
      "terminated"
    ] as const) {
      process.exitCode = 0;
      applyJobExitCode({
        jobName: "x",
        runId: "x",
        correlationId: "x",
        status,
        startedAt: "",
        finishedAt: "",
        durationMs: 0,
        dryRun: false
      });
      expect(process.exitCode).toBe(1);
    }
    process.exitCode = 0;
  });
});

describe("parseJobCliArgs (Issue #697)", () => {
  test("defaults to no dry-run and no json output path", () => {
    expect(parseJobCliArgs([])).toEqual({
      dryRun: false,
      jsonOutputPath: null
    });
  });

  test("parses --dry-run", () => {
    expect(parseJobCliArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("parses --json-output=<path>", () => {
    expect(
      parseJobCliArgs(["--json-output=/tmp/out.json"]).jsonOutputPath
    ).toBe("/tmp/out.json");
  });

  test("parses both flags together", () => {
    expect(parseJobCliArgs(["--dry-run", "--json-output=out.json"])).toEqual({
      dryRun: true,
      jsonOutputPath: "out.json"
    });
  });
});
