/**
 * Standalone CLI fixture for `job-runner.integration.test.ts`'s SIGTERM
 * proof — run as a SEPARATE `bun` subprocess (real OS-level signal delivery
 * cannot be exercised against a handler running in the SAME process as the
 * test, since the test process itself would receive/react to the signal
 * too). Mirrors the existing `tests/e2e/helpers/seed-*-cli.ts` pattern of a
 * thin CLI wrapper spawned by an integration/e2e test.
 *
 * Runs a job whose handler hangs until the runner's `AbortSignal` fires
 * (from SIGTERM, in this fixture's case — `timeoutMs` is set high enough
 * that only the signal, never the timeout, can trigger it in this
 * fixture's own test usage). Prints `HANDLER_STARTED` the moment the
 * handler begins — since `runJob` only invokes the handler AFTER
 * successfully acquiring the advisory lock, this line is the test's proof
 * the lock is actually held, safe to use as the "now send SIGTERM" signal.
 * Prints the final `JobResult` as one JSON line on its own last line before
 * exiting.
 *
 * Usage: `bun tests/integration/job-runner-long-job-fixture.ts <databaseUrl> <jobName>`
 */
import { runJob } from "../../src/lib/jobs/job-runner";

const [databaseUrl, jobName] = process.argv.slice(2);

if (!databaseUrl || !jobName) {
  console.error(
    "Usage: bun job-runner-long-job-fixture.ts <databaseUrl> <jobName>"
  );
  process.exit(1);
}

const sql = new Bun.SQL(databaseUrl, { max: 2 });

const result = await runJob(
  {
    name: jobName,
    description: "Long-running fixture job for integration tests.",
    timeoutMs: 60_000,
    handler: async (ctx) => {
      console.log("HANDLER_STARTED");

      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      return { detail: "handler observed abort and returned" };
    }
  },
  { sql }
);

console.log(JSON.stringify(result));
await sql.close({ timeout: 1 });
