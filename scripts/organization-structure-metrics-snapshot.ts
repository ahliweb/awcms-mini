/**
 * organization-structure-metrics-snapshot.ts — `bun run
 * organization-structure:metrics-snapshot`.
 *
 * Issue #749 (epic #738 platform-evolution, Wave 2). Scheduled worker
 * entrypoint for `runOrganizationStructureMetricsSnapshot`
 * (`src/modules/organization-structure/application/organization-
 * structure-metrics-snapshot.ts`) — same shape as
 * `scripts/identity-access-business-scope-expiry.ts`: built on the shared
 * worker runner (advisory lock, timeout, SIGTERM/SIGINT-aware
 * cancellation, JSON telemetry). Read-only — never mutates a row, safe to
 * run as often as desired.
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
import { runOrganizationStructureMetricsSnapshot } from "../src/modules/organization-structure/application/organization-structure-metrics-snapshot";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "organization-structure:metrics-snapshot",
        description:
          "Read-only per-tenant snapshot of active organization units, hierarchy max depth, and expiring-soon assignments, recorded as gauges via the shared metrics port.",
        handler: async (ctx) => {
          const snapshotResult =
            await runOrganizationStructureMetricsSnapshot(sql);

          console.log(
            `organization-structure:metrics-snapshot complete — correlationId=${ctx.correlationId} ` +
              `tenants=${snapshotResult.tenantsChecked}`
          );

          return {
            status: "success",
            itemCounts: {
              tenantsChecked: snapshotResult.tenantsChecked
            }
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
