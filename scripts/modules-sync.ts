/**
 * modules-sync.ts — `bun run modules:sync`.
 *
 * Issue #513 (epic #510, Module Management). CLI wrapper for
 * `syncModuleDescriptors` (`src/modules/module-management/application/
 * descriptor-sync.ts`) — reads the trusted code registry (`listModules()`)
 * and upserts it into the database-backed registry. Safe to run on every
 * deploy (idempotent, no network calls, no user input).
 *
 * Issue #680 (epic #679) — refuses to sync a registry whose dependency
 * graph is broken (self-dependency, duplicate, missing key, or cycle):
 * writing a known-bad graph into the DB mirror table would just make the
 * corruption durable and harder to notice than failing here, before any
 * row is touched. Same validator `bun run modules:dag:check`/`bun run
 * check` already gate on, reused rather than duplicated.
 *
 * Migrated to the shared worker runner (`src/lib/jobs/job-runner.ts`, Issue
 * #697) as the 2nd of the 2 representative jobs the issue asks for —
 * chosen specifically because it is a NON-tenant-loop job (a single global
 * upsert against code-derived, RLS-free registry tables), the opposite
 * shape from `scripts/audit-log-purge.ts`'s tenant-iterating batch job, to
 * prove the runner works for both shapes. Behavior for a normal
 * (non-dry-run) invocation is UNCHANGED: same DAG validation gate, same
 * `syncModuleDescriptors` call, same created/updated/unchanged/orphaned
 * result — only the orchestration (lock, correlation id, exit code, JSON
 * telemetry) moved into the shared runner.
 *
 * New on top of the pre-migration behavior:
 * - **Advisory lock**: two concurrent `bun run modules:sync` invocations
 *   (e.g. two deploy pipelines racing) no longer both upsert at once — the
 *   second safely skips.
 * - **`--dry-run`**: computes the exact same create/update/unchanged/
 *   orphaned diff a real run would act on (`planModuleSync`, via the
 *   already-exported, read-only `fetchExistingModules`), without writing
 *   anything.
 * - **`--json-output=<path>`**: structured run telemetry, same pattern as
 *   `scripts/production-preflight.ts`.
 */
import { getDatabaseClient } from "../src/lib/database/client";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry
} from "../src/lib/jobs/job-runner";
import {
  fetchExistingModules,
  syncModuleDescriptors
} from "../src/modules/module-management/application/descriptor-sync";
import { planModuleSync } from "../src/modules/module-management/domain/descriptor-diff";
import { listModules } from "../src/modules";
import {
  formatModuleDependencyGraphIssue,
  validateModuleDependencyGraph
} from "../src/modules/module-management/domain/module-dependency-graph";

async function main() {
  const graphResult = validateModuleDependencyGraph(listModules());

  if (!graphResult.valid) {
    console.error("modules:sync FAILED — dependency graph is invalid:");
    for (const issue of graphResult.issues) {
      console.error(`  ${formatModuleDependencyGraphIssue(issue)}`);
    }
    process.exitCode = 1;
    return;
  }

  const sql = getDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "modules:sync",
        description:
          "Syncs the trusted code module registry (listModules()) into awcms_mini_modules.",
        handler: async (ctx) => {
          if (ctx.dryRun) {
            const existingRows = await fetchExistingModules(sql);
            const plan = planModuleSync(listModules(), existingRows);
            const toCreate = plan.entries
              .filter((entry) => entry.action === "create")
              .map((entry) => entry.moduleKey);
            const toUpdate = plan.entries
              .filter((entry) => entry.action === "update")
              .map((entry) => entry.moduleKey);
            const unchanged = plan.entries.filter(
              (entry) => entry.action === "unchanged"
            );

            console.log(
              `modules:sync (dry-run) — would create=${toCreate.length} ` +
                `update=${toUpdate.length} unchanged=${unchanged.length} ` +
                `orphaned=${plan.orphanedModuleKeys.length}`
            );
            if (toCreate.length > 0) {
              console.log(`  would create: ${toCreate.join(", ")}`);
            }
            if (toUpdate.length > 0) {
              console.log(`  would update: ${toUpdate.join(", ")}`);
            }
            if (plan.orphanedModuleKeys.length > 0) {
              console.log(
                `  would mark orphaned (disabled, not deleted): ${plan.orphanedModuleKeys.join(", ")}`
              );
            }

            return {
              itemCounts: {
                created: toCreate.length,
                updated: toUpdate.length,
                unchanged: unchanged.length,
                orphaned: plan.orphanedModuleKeys.length
              }
            };
          }

          const syncResult = await syncModuleDescriptors(sql);

          console.log(
            `modules:sync complete — created=${syncResult.created.length} ` +
              `updated=${syncResult.updated.length} unchanged=${syncResult.unchanged.length} ` +
              `orphaned=${syncResult.orphaned.length}`
          );
          if (syncResult.created.length > 0) {
            console.log(`  created: ${syncResult.created.join(", ")}`);
          }
          if (syncResult.updated.length > 0) {
            console.log(`  updated: ${syncResult.updated.join(", ")}`);
          }
          if (syncResult.orphaned.length > 0) {
            console.log(
              `  orphaned (marked disabled, not deleted): ${syncResult.orphaned.join(", ")}`
            );
          }

          return {
            itemCounts: {
              created: syncResult.created.length,
              updated: syncResult.updated.length,
              unchanged: syncResult.unchanged.length,
              orphaned: syncResult.orphaned.length
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
