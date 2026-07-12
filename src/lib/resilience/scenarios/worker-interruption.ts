/**
 * "worker-interruption" scenario (Issue #699). Reuses the EXACT spawn-and-
 * signal pattern `tests/integration/job-runner.integration.test.ts` (Issue
 * #697) already proved out: a real, separate `bun` OS process running
 * `tests/integration/job-runner-long-job-fixture.ts` on top of the real
 * `src/lib/jobs/job-runner.ts`, sent a genuine `SIGTERM` (not a fake/in-
 * process abort — a handler running in the same process as the test
 * cannot exercise real OS-level signal delivery). Not reimplemented here;
 * this scenario just drives the existing fixture from
 * `scripts/dr-drill.ts` instead of from `bun:test`.
 *
 * Phases:
 * - Setup: spawn the fixture with a fresh unique job name, wait for its
 *   `HANDLER_STARTED` line (proof the advisory lock is genuinely held).
 * - Execute: send a real `SIGTERM`.
 * - Verify: the fixture's own `JobResult.status` is `"terminated"` (a
 *   graceful, bounded response — not a hang, not a crash) — this is the
 *   scenario's RTO-like metric (signal-to-exit latency). Then, to prove
 *   retry/idempotency (the advisory lock was NOT left stuck, which would
 *   either deadlock every future run of this job or — worse — let two
 *   overlapping runs execute at once): spawn+signal the SAME job name a
 *   second time and confirm it starts (acquires the lock) and terminates
 *   cleanly again promptly.
 * - Cleanup: nothing persistent — both fixture runs are short-lived
 *   subprocesses; the advisory lock itself is a Postgres session-level
 *   lock released when each spawned process's connection closes.
 */
import { join } from "node:path";

import type { JobResult } from "../../jobs/job-runner";
import type { ScenarioDefinition, ScenarioOutcome } from "../scenario-runner";

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "tests",
  "integration",
  "job-runner-long-job-fixture.ts"
);

function uniqueJobName(label: string): string {
  return `dr-drill:worker-interruption:${label}:${crypto.randomUUID()}`;
}

async function spawnWaitStartThenSigterm(
  databaseUrl: string,
  jobName: string
): Promise<{ result: JobResult; signalToExitMs: number }> {
  const proc = Bun.spawn(["bun", FIXTURE_PATH, databaseUrl, jobName], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!buffer.includes("HANDLER_STARTED")) {
    const { value, done } = await reader.read();

    if (done) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `worker-interruption fixture exited before starting its handler; ` +
          `stdout="${buffer}" stderr="${stderr}"`
      );
    }

    buffer += decoder.decode(value, { stream: true });
  }

  const signalStart = performance.now();
  proc.kill("SIGTERM");

  let done = false;

  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  await proc.exited;
  const signalToExitMs = performance.now() - signalStart;

  const lines = buffer.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const result = JSON.parse(lastLine) as JobResult;

  return { result, signalToExitMs };
}

export function workerInterruptionScenario(): ScenarioDefinition {
  return {
    name: "worker-interruption",
    tier: "safe",
    timeoutMs: 30_000,
    async run(ctx): Promise<ScenarioOutcome> {
      const jobName = uniqueJobName("real-sigterm");

      const first = await spawnWaitStartThenSigterm(ctx.databaseUrl, jobName);

      if (first.result.status !== "terminated") {
        return {
          ok: false,
          detail:
            `Expected the fixture's status to be "terminated" after a real ` +
            `SIGTERM, got "${first.result.status}".`
        };
      }

      // Retry/idempotency proof: the SAME job name must be re-acquirable
      // promptly — a stuck lock would either hang here (deadlock) or, if
      // the lock somehow "leaked" instead as always-free, would let this
      // second run and a hypothetical still-running first run genuinely
      // overlap (the duplicate-side-effect failure mode this scenario
      // exists to rule out).
      const retryStart = performance.now();
      const retry = await spawnWaitStartThenSigterm(ctx.databaseUrl, jobName);
      const lockReacquireMs = performance.now() - retryStart;

      if (retry.result.status !== "terminated") {
        return {
          ok: false,
          detail:
            `Retry run (same job name "${jobName}") did not start/terminate ` +
            `cleanly — expected "terminated", got "${retry.result.status}". ` +
            "This suggests the advisory lock was left stuck by the first " +
            "interruption (a duplicate-blocking/deadlock failure mode)."
        };
      }

      return {
        ok: true,
        detail:
          `A real SIGTERM produced status="terminated" in ` +
          `${first.signalToExitMs.toFixed(0)}ms, and the SAME job name was ` +
          `re-acquired and cleanly re-terminated ${lockReacquireMs.toFixed(0)}ms ` +
          "later — the advisory lock was not left stuck after interruption " +
          "(no duplicate-blocking, no deadlock).",
        metrics: {
          signalToExitMs: Number(first.signalToExitMs.toFixed(1)),
          lockReacquireMs: Number(lockReacquireMs.toFixed(1))
        }
      };
    }
  };
}
