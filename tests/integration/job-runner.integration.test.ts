/**
 * Integration tests for the shared worker runner (`src/lib/jobs/job-
 * runner.ts`, `./advisory-lock.ts`, Issue #697, epic #679) against a REAL
 * PostgreSQL — the genuine `pg_try_advisory_lock`/`pg_advisory_unlock`
 * session semantics a fake/in-memory `sql` (see
 * `tests/unit/job-runner.test.ts`) cannot exercise: two truly separate
 * reserved connections actually contending for the same lock, and a truly
 * separate OS process receiving a real SIGTERM.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { describe, expect, test } from "bun:test";

import { getAdminDatabaseUrl, integrationEnabled } from "./harness";

import { acquireAdvisoryLock } from "../../src/lib/jobs/advisory-lock";
import { runJob, type JobResult } from "../../src/lib/jobs/job-runner";

const suite = integrationEnabled ? describe : describe.skip;

function uniqueJobName(label: string): string {
  return `test:job-runner-integration:${label}:${crypto.randomUUID()}`;
}

/**
 * Spawns `tests/integration/job-runner-long-job-fixture.ts` as a real
 * separate `bun` process, waits for its `HANDLER_STARTED` line (proof the
 * advisory lock is genuinely held by that OTHER process), sends a real OS
 * signal to it, then waits for it to exit and parses its final JSON line
 * (the fixture's own `JobResult`).
 */
async function runFixtureAndSignal(
  jobName: string,
  signal: "SIGTERM" | "SIGINT"
): Promise<{ exitCode: number; result: JobResult }> {
  const proc = Bun.spawn(
    [
      "bun",
      "tests/integration/job-runner-long-job-fixture.ts",
      getAdminDatabaseUrl(),
      jobName
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!buffer.includes("HANDLER_STARTED")) {
    const { value, done } = await reader.read();
    if (done) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `fixture exited before starting its handler; stdout="${buffer}" stderr="${stderr}"`
      );
    }
    buffer += decoder.decode(value, { stream: true });
  }

  proc.kill(signal);

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  const exitCode = await proc.exited;
  const lines = buffer.trim().split("\n");
  const lastLine = lines[lines.length - 1]!;
  const result = JSON.parse(lastLine) as JobResult;

  return { exitCode, result };
}

suite(
  "shared worker runner — advisory lock (real Postgres, Issue #697)",
  () => {
    test("two real, separate connections both trying pg_try_advisory_lock for the same job: only one acquires it", async () => {
      const sql = new Bun.SQL(getAdminDatabaseUrl(), { max: 4 });
      const jobName = uniqueJobName("raw-contention");

      try {
        const [first, second] = await Promise.all([
          acquireAdvisoryLock(sql, jobName),
          acquireAdvisoryLock(sql, jobName)
        ]);

        const acquiredCount = [first, second].filter(
          (handle) => handle !== null
        ).length;
        expect(acquiredCount).toBe(1);

        // Whichever one got it must release cleanly, and the lock must then
        // be acquirable again — proof this isn't a one-shot fluke.
        await first?.release();
        await second?.release();

        const third = await acquireAdvisoryLock(sql, jobName);
        expect(third).not.toBeNull();
        await third?.release();
      } finally {
        await sql.close({ timeout: 1 });
      }
    });

    test("runJob: a second real instance of the same job SKIPS (never runs its handler) while the first still holds the lock, and can run once the first releases", async () => {
      const sql = new Bun.SQL(getAdminDatabaseUrl(), { max: 4 });
      const jobName = uniqueJobName("skip-then-run");

      try {
        const holder = await acquireAdvisoryLock(sql, jobName);
        expect(holder).not.toBeNull();

        let handlerRan = false;
        const skipped = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => {
              handlerRan = true;
              return {};
            }
          },
          { sql }
        );

        expect(skipped.status).toBe("skipped");
        expect(handlerRan).toBe(false);

        await holder?.release();

        const ran = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => {
              handlerRan = true;
              return { itemCounts: { done: 1 } };
            }
          },
          { sql }
        );

        expect(ran.status).toBe("success");
        expect(handlerRan).toBe(true);
      } finally {
        await sql.close({ timeout: 1 });
      }
    });

    test("runJob: releases the lock on a real success, proven by an immediate next run succeeding (not skipping)", async () => {
      const sql = new Bun.SQL(getAdminDatabaseUrl(), { max: 4 });
      const jobName = uniqueJobName("success-release");

      try {
        const first = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => ({ itemCounts: { ok: 1 } })
          },
          { sql }
        );
        expect(first.status).toBe("success");

        const second = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => ({ itemCounts: { ok: 1 } })
          },
          { sql }
        );
        expect(second.status).toBe("success");
      } finally {
        await sql.close({ timeout: 1 });
      }
    });

    test("runJob: releases the lock when the handler throws mid-run, proven by an immediate next run succeeding (not skipping)", async () => {
      const sql = new Bun.SQL(getAdminDatabaseUrl(), { max: 4 });
      const jobName = uniqueJobName("error-release");

      try {
        const failed = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => {
              throw new Error("simulated mid-run failure");
            }
          },
          { sql }
        );
        expect(failed.status).toBe("failed");
        expect(failed.error?.message).toContain("simulated mid-run failure");

        const second = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => ({ itemCounts: { ok: 1 } })
          },
          { sql }
        );
        expect(second.status).toBe("success");
      } finally {
        await sql.close({ timeout: 1 });
      }
    });

    test("PR #713 fix (security-auditor High finding): a real timeout (handler never resolves, never checks signal) keeps the lock held — an immediate retry is skipped, not allowed to overlap — until the grace period elapses", async () => {
      const sql = new Bun.SQL(getAdminDatabaseUrl(), { max: 4 });
      const jobName = uniqueJobName("timeout-release");

      try {
        const timedOut = await runJob(
          {
            name: jobName,
            description: "test",
            timeoutMs: 50,
            lockReleaseGraceMs: 150,
            handler: () => new Promise(() => {})
          },
          { sql }
        );
        expect(timedOut.status).toBe("timeout");

        // Immediately after runJob's own promise resolved, the (forever)
        // still-running handler must still hold the lock.
        const immediateRetry = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => ({ itemCounts: { ok: 1 } })
          },
          { sql }
        );
        expect(immediateRetry.status).toBe("skipped");

        // Once the grace period elapses, the detached background release
        // fires and the lock becomes available again.
        await new Promise((resolve) => setTimeout(resolve, 250));

        const afterGrace = await runJob(
          {
            name: jobName,
            description: "test",
            handler: async () => ({ itemCounts: { ok: 1 } })
          },
          { sql }
        );
        expect(afterGrace.status).toBe("success");
      } finally {
        await sql.close({ timeout: 1 });
      }
    }, 10_000);

    test("PR #713 REGRESSION FIX — the auditor's exact scenario: timeout fires while the handler is still genuinely mid-execution; a second acquireAdvisoryLock attempt is REJECTED for as long as the first handler is actually still running, not just until runJob returns its timeout result", async () => {
      const sql = new Bun.SQL(getAdminDatabaseUrl(), { max: 4 });
      const jobName = uniqueJobName("mid-handler-timeout");
      const HANDLER_REAL_DURATION_MS = 300;

      try {
        let handlerFinished = false;

        const timedOut = await runJob(
          {
            name: jobName,
            description: "test",
            timeoutMs: 30,
            lockReleaseGraceMs: 5_000,
            handler: async () => {
              // Simulates real, already-in-flight work (e.g. one
              // statement/transaction of a tenant loop) that genuinely
              // outlives the timeout — does NOT check the signal, the
              // worst case for cooperative cancellation.
              await new Promise((resolve) =>
                setTimeout(resolve, HANDLER_REAL_DURATION_MS)
              );
              handlerFinished = true;
              return {};
            }
          },
          { sql }
        );

        expect(timedOut.status).toBe("timeout");
        // runJob returned promptly, well before the handler's own 300ms
        // completes.
        expect(handlerFinished).toBe(false);

        // THE AUDITOR'S EXACT SCENARIO: immediately after runJob's own
        // promise resolves, attempt to acquire the SAME job's lock again —
        // it must be rejected while the first handler is genuinely still
        // running. Before the fix, this would have succeeded here (the
        // lock was released synchronously in the timeout branch),
        // allowing a second overlapping execution while the first
        // handler's real work was still in flight.
        const immediateRetry = await acquireAdvisoryLock(sql, jobName);
        expect(immediateRetry).toBeNull();
        expect(handlerFinished).toBe(false);

        // Wait past the handler's own real completion, with margin.
        await new Promise((resolve) =>
          setTimeout(resolve, HANDLER_REAL_DURATION_MS + 200)
        );
        expect(handlerFinished).toBe(true);

        // Only NOW — after the handler has actually stopped — is the lock
        // acquirable again.
        const afterHandlerSettled = await acquireAdvisoryLock(sql, jobName);
        expect(afterHandlerSettled).not.toBeNull();
        await afterHandlerSettled?.release();
      } finally {
        await sql.close({ timeout: 1 });
      }
    }, 10_000);

    test("runJob: a real SIGTERM to a separate OS process releases the lock, proven by the test process immediately re-acquiring it", async () => {
      const jobName = uniqueJobName("sigterm-release");

      const { exitCode, result } = await runFixtureAndSignal(
        jobName,
        "SIGTERM"
      );

      expect(exitCode).toBe(0);
      expect(result.status).toBe("terminated");
      expect(result.detail).toContain("SIGTERM");

      const sql = new Bun.SQL(getAdminDatabaseUrl(), { max: 2 });
      try {
        const reacquired = await acquireAdvisoryLock(sql, jobName);
        expect(reacquired).not.toBeNull();
        await reacquired?.release();
      } finally {
        await sql.close({ timeout: 1 });
      }
    }, 15_000);
  }
);
