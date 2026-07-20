/**
 * usage-metering-purge.ts — `bun run usage-metering:purge`.
 *
 * Issue #875 (epic #868 SaaS control plane, Wave 1, ADR-0022 §8). Scheduled
 * worker entrypoint for `runUsageMeteringPurge`
 * (`src/modules/usage-metering/application/purge-job.ts`) — same shape as
 * `scripts/audit-log-purge.ts`: shared worker runner (advisory lock, timeout,
 * SIGTERM/SIGINT cancellation, JSON telemetry), not exposed over HTTP.
 *
 * The single real enforcement point for the delegated `usage_metering.events`
 * data_lifecycle policy: deletes usage corrections then events past their
 * retention cutoff for every active tenant, in bounded batches, honoring an
 * active legal hold. Retention resolves from `--retention-days=<n>`, then
 * `USAGE_EVENT_RETENTION_DAYS`, then the 730-day (2-year) default.
 *
 * `--dry-run`: reports active tenants without deleting anything or writing any
 * purge audit event.
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
import { legalHoldGuardPortAdapter } from "../src/modules/data-lifecycle/application/legal-hold-guard-port-adapter";
import { runUsageMeteringPurge } from "../src/modules/usage-metering/application/purge-job";

function resolveRetentionDaysFlag(): number | undefined {
  const flag = process.argv.find((arg) => arg.startsWith("--retention-days="));
  if (!flag) {
    return undefined;
  }
  const parsed = Number(flag.split("=")[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));
  const retentionDays = resolveRetentionDaysFlag();

  try {
    const result = await runJob(
      {
        name: "usage-metering:purge",
        description:
          "Deletes usage corrections then events past their retention cutoff for every active tenant, in bounded batches, honoring legal holds (the delegated data_lifecycle adopter for usage_metering.events).",
        handler: async (ctx) => {
          const purgeResult = await runUsageMeteringPurge(
            sql,
            ctx,
            legalHoldGuardPortAdapter,
            { retentionDays }
          );
          const hitPassLimit = purgeResult.tenantsHitPassLimit.length > 0;

          console.log(
            `usage-metering:purge complete — correlationId=${ctx.correlationId} ` +
              `tenants=${purgeResult.tenantsChecked} events=${purgeResult.purgedEvents} ` +
              `corrections=${purgeResult.purgedCorrections} cutoff=${purgeResult.cutoffIso}` +
              (ctx.dryRun ? " (dry-run: nothing was purged)" : "") +
              (hitPassLimit
                ? ` (WARNING: ${purgeResult.tenantsHitPassLimit.length} tenant(s) still had backlog after the pass-count safety bound)`
                : "")
          );

          return {
            status: hitPassLimit ? "partial" : "success",
            itemCounts: {
              tenantsChecked: purgeResult.tenantsChecked,
              purgedEvents: purgeResult.purgedEvents,
              purgedCorrections: purgeResult.purgedCorrections,
              tenantsHitPassLimit: purgeResult.tenantsHitPassLimit.length
            },
            detail: hitPassLimit
              ? `Backlog not fully drained for: ${purgeResult.tenantsHitPassLimit.join(", ")}`
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
