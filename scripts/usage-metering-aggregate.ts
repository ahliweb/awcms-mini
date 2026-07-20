/**
 * usage-metering-aggregate.ts — `bun run usage-metering:aggregate`.
 *
 * Issue #875 (epic #868 SaaS control plane, Wave 1, ADR-0022). Scheduled worker
 * entrypoint for `runUsageAggregation`
 * (`src/modules/usage-metering/application/aggregation-job.ts`) — same shape as
 * `scripts/audit-log-purge.ts` / `scripts/data-lifecycle-archive-purge.ts`:
 * built on the shared worker runner (advisory lock, timeout, SIGTERM/SIGINT
 * cancellation, JSON telemetry), not exposed over HTTP (an unattended
 * maintenance operation, not a user action).
 *
 * Drains the usage events/corrections outbox for every active tenant and
 * deterministically (re)materializes the touched usage windows — lease +
 * checkpoint + bounded batch, recompute-from-source (idempotent replay), and
 * consumes any requested rebuild. A no-op tick when there is no backlog.
 *
 * `--dry-run`: reports how many active tenants WOULD be visited without claiming
 * a lease or mutating any aggregate/checkpoint.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry
} from "../src/lib/jobs/job-runner";
import { listModules } from "../src/modules";
import { runUsageAggregation } from "../src/modules/usage-metering/application/aggregation-job";
import { buildContractRegistry } from "../src/modules/usage-metering/application/meter-registry";

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 045/087's
  // own grants (SELECT source, INSERT/UPDATE aggregates + cursors).
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));
  const registry = buildContractRegistry(listModules());

  try {
    const result = await runJob(
      {
        name: "usage-metering:aggregate",
        description:
          "Drains the usage events/corrections outbox for every active tenant and deterministically (re)materializes touched usage windows (lease + checkpoint + bounded batch, recompute-from-source), consuming any requested rebuild.",
        handler: async (ctx) => {
          const aggResult = await runUsageAggregation(sql, ctx, registry);
          const hitPassLimit = aggResult.tenantsHitPassLimit.length > 0;

          console.log(
            `usage-metering:aggregate complete — correlationId=${ctx.correlationId} ` +
              `tenants=${aggResult.tenantsChecked} processed=${aggResult.totalProcessed}` +
              (ctx.dryRun ? " (dry-run: nothing was materialized)" : "") +
              (hitPassLimit
                ? ` (WARNING: ${aggResult.tenantsHitPassLimit.length} tenant(s) still had backlog after the pass-count safety bound)`
                : "")
          );

          return {
            status: hitPassLimit ? "partial" : "success",
            itemCounts: {
              tenantsChecked: aggResult.tenantsChecked,
              processed: aggResult.totalProcessed,
              tenantsHitPassLimit: aggResult.tenantsHitPassLimit.length
            },
            detail: hitPassLimit
              ? `Backlog not fully drained for: ${aggResult.tenantsHitPassLimit.join(", ")}`
              : undefined
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
