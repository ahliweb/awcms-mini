/**
 * data-exchange-worker.ts — `bun run data-exchange:worker`.
 *
 * Issue #752 (epic `platform-evolution` #738, Wave 3). Internal worker
 * entrypoint for `runDataExchangeWorkerPassForTenant`
 * (`src/modules/data-exchange/application/data-exchange-worker.ts`) —
 * intended to run on a schedule (cron/systemd timer/k8s CronJob), not
 * exposed over HTTP, same "trusted internal worker" convention every other
 * dispatcher script in this repo already uses (`domain-events-dispatch.ts`,
 * `data-lifecycle-archive-purge.ts`).
 *
 * Built on the shared worker runner (`src/lib/jobs/job-runner.ts`) —
 * advisory lock, timeout + SIGTERM/SIGINT cancellation, `--dry-run`,
 * `--json-output=<path>`, and JSON telemetry all come from `runJob`.
 * `iterateTenantsInBatches` (`src/lib/jobs/batching.ts`) bounds the
 * per-tenant loop: a tenant with a large backlog gets multiple passes in
 * one run (bounded by `maxPasses`, default 50) until its backlog is
 * drained or the safety bound is hit.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import {
  fetchActiveTenants,
  iterateTenantsInBatches
} from "../src/lib/jobs/batching";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry,
  type JobContext
} from "../src/lib/jobs/job-runner";
import { runDataExchangeWorkerPassForTenant } from "../src/modules/data-exchange/application/data-exchange-worker";

export type DataExchangeWorkerOptions = {
  maxPasses?: number;
};

export type DataExchangeWorkerRunResult = {
  tenantsChecked: number;
  validated: number;
  committed: number;
  exported: number;
  tenantsHitPassLimit: string[];
};

/**
 * Core logic, extracted from `main()` so
 * `tests/integration/data-exchange-worker-job.integration.test.ts` can
 * exercise it directly without spawning a subprocess (same pattern
 * `runDomainEventsDispatch`/`domain-events-dispatch.ts` established).
 * `--dry-run` is a true read-only preview — it never calls the real
 * validate/commit/export passes (all of which perform real DB writes).
 */
export async function runDataExchangeWorker(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  options: DataExchangeWorkerOptions = {}
): Promise<DataExchangeWorkerRunResult> {
  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);
    return {
      tenantsChecked: tenants.length,
      validated: 0,
      committed: 0,
      exported: 0,
      tenantsHitPassLimit: []
    };
  }

  const { tenants, perTenant } = await iterateTenantsInBatches(
    sql,
    async (tenantId) =>
      runDataExchangeWorkerPassForTenant(sql, tenantId, ctx.correlationId),
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  const tenantsHitPassLimit = [...perTenant.entries()]
    .filter(([, outcome]) => outcome.hitPassLimit)
    .map(([tenantId]) => tenantId);

  const aggregated = [...perTenant.values()]
    .flatMap((outcome) => outcome.passes)
    .reduce(
      (acc, pass) => ({
        validated: acc.validated + pass.validated,
        committed: acc.committed + pass.committed,
        exported: acc.exported + pass.exported
      }),
      { validated: 0, committed: 0, exported: 0 }
    );

  return {
    tenantsChecked: tenants.length,
    tenantsHitPassLimit,
    ...aggregated
  };
}

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "data-exchange:worker",
        description:
          "Parses/validates staged import batches, commits previewed batches in bounded resumable passes, executes queued export jobs, and records reconciliation reports for every active tenant.",
        handler: async (ctx) => {
          const workerResult = await runDataExchangeWorker(sql, ctx);
          const hitPassLimit = workerResult.tenantsHitPassLimit.length > 0;

          console.log(
            `data-exchange:worker complete — correlationId=${ctx.correlationId} ` +
              `tenants=${workerResult.tenantsChecked} validated=${workerResult.validated} ` +
              `committed=${workerResult.committed} exported=${workerResult.exported}` +
              (ctx.dryRun ? " (dry-run: nothing was processed)" : "") +
              (hitPassLimit
                ? ` (WARNING: ${workerResult.tenantsHitPassLimit.length} tenant(s) still had backlog remaining after the pass-count safety bound)`
                : "")
          );

          return {
            status: hitPassLimit ? "partial" : "success",
            itemCounts: {
              tenantsChecked: workerResult.tenantsChecked,
              validated: workerResult.validated,
              committed: workerResult.committed,
              exported: workerResult.exported
            },
            detail: `validated=${workerResult.validated} committed=${workerResult.committed} exported=${workerResult.exported}`
          };
        }
      },
      { sql, dryRun: cliOptions.dryRun }
    );

    printJobTelemetry(result);
    await writeJobTelemetry(result, cliOptions.jsonOutputPath);

    if (!isJobResultOk(result)) {
      console.error(formatJobOutcomeLine(result));
    }

    applyJobExitCode(result);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
