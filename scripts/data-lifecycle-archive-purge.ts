/**
 * data-lifecycle-archive-purge.ts — `bun run data-lifecycle:archive-purge`.
 *
 * Issue #745 (epic #738 platform-evolution, Wave 1). Scheduled worker
 * entrypoint for `runDataLifecycleArchivePurge`
 * (`src/modules/data-lifecycle/application/archive-purge-job.ts`) — same
 * shape as `scripts/audit-log-purge.ts` (Issue #697/#447): built on the
 * shared worker runner (advisory lock, timeout, SIGTERM/SIGINT-aware
 * cancellation, JSON telemetry), not exposed over HTTP (an unattended
 * maintenance operation, not a user action — same reasoning
 * `audit-log-purge.ts`'s own header documents).
 *
 * `--dry-run`: computes and records dry-run snapshots for every
 * registered descriptor (both `"delegated"` and `"generic"`) without any
 * mutation — safe to run in production to preview backlog/held/purgeable
 * counts before scheduling for real.
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
import { runDataLifecycleArchivePurge } from "../src/modules/data-lifecycle/application/archive-purge-job";
import { resolveDataLifecycleConfig } from "../src/modules/data-lifecycle/domain/data-lifecycle-config";
import { createLocalArchiveAdapter } from "../src/modules/data-lifecycle/infrastructure/local-archive-adapter";

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 056's
  // own grants.
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));
  const config = resolveDataLifecycleConfig();
  const archivePort = createLocalArchiveAdapter(config.archiveRootPath);

  try {
    const result = await runJob(
      {
        name: "data-lifecycle:archive-purge",
        description:
          "Archives (where applicable) and purges rows past retention for every registered generic-execution high-volume table descriptor, and records a dry-run backlog snapshot for every delegated (existing-adopter) descriptor.",
        handler: async (ctx) => {
          const purgeResult = await runDataLifecycleArchivePurge(sql, ctx, {
            archivePort
          });
          const hitPassLimit = purgeResult.tenantsHitPassLimit.length > 0;

          console.log(
            `data-lifecycle:archive-purge complete — correlationId=${ctx.correlationId} ` +
              `tenants=${purgeResult.tenantsChecked} generic=${purgeResult.descriptorsGeneric} ` +
              `delegated=${purgeResult.descriptorsDelegated} archived=${purgeResult.totalArchived} ` +
              `purged=${purgeResult.totalPurged} dryRunEligible=${purgeResult.totalDryRunEligible}` +
              (ctx.dryRun ? " (dry-run: nothing was archived/purged)" : "") +
              (hitPassLimit
                ? ` (WARNING: ${purgeResult.tenantsHitPassLimit.length} tenant(s) still had backlog remaining after the pass-count safety bound)`
                : "")
          );

          return {
            status: hitPassLimit ? "partial" : "success",
            itemCounts: {
              tenantsChecked: purgeResult.tenantsChecked,
              archived: purgeResult.totalArchived,
              purged: purgeResult.totalPurged,
              dryRunEligible: purgeResult.totalDryRunEligible,
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
