/**
 * Integration tests for `scripts/modules-sync.ts`'s migration to the shared
 * worker runner (`src/lib/jobs/job-runner.ts`, Issue #697, epic #679)
 * against a real PostgreSQL.
 *
 * Deliberately does NOT re-test `syncModuleDescriptors`'s own create/
 * update/unchanged/orphan behavior — that is already covered end-to-end by
 * `tests/integration/module-management-sync.integration.test.ts` (the
 * exact same function this script calls). This file only covers what the
 * MIGRATION added: `--dry-run`'s read-only plan matches what a real run
 * would do without writing anything, and the advisory lock actually
 * prevents two concurrent `bun run modules:sync` invocations from both
 * upserting at once — the non-tenant-loop counterpart to
 * `audit-log-purge-job.integration.test.ts`'s tenant-iterating proof.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { runJob } from "../../src/lib/jobs/job-runner";
import {
  fetchExistingModules,
  syncModuleDescriptors
} from "../../src/modules/module-management/application/descriptor-sync";
import { planModuleSync } from "../../src/modules/module-management/domain/descriptor-diff";
import { listModules } from "../../src/modules";

async function countModuleRows(): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT count(*)::int AS count FROM awcms_mini_modules
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("modules:sync migrated to shared worker runner (Issue #697)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("--dry-run on an empty registry reports every module as 'would create' and writes nothing", async () => {
    const sql = getTestSql();
    const existingRows = await fetchExistingModules(sql);
    const plan = planModuleSync(listModules(), existingRows);

    expect(plan.entries.every((entry) => entry.action === "create")).toBe(true);
    expect(plan.entries).toHaveLength(listModules().length);

    expect(await countModuleRows()).toBe(0);
  });

  test("runJob-wrapped sync (non-dry-run) has an identical effect to calling syncModuleDescriptors directly (regression)", async () => {
    const sql = getTestSql();
    let created: string[] = [];

    const result = await runJob(
      {
        name: "modules:sync",
        description: "test",
        handler: async () => {
          const syncResult = await syncModuleDescriptors(sql);
          created = syncResult.created;
          return { itemCounts: { created: syncResult.created.length } };
        }
      },
      { sql }
    );

    expect(result.status).toBe("success");
    expect(created.sort()).toEqual(
      [...listModules()].map((module) => module.key).sort()
    );
    expect(await countModuleRows()).toBe(listModules().length);
  });

  test("--dry-run after a real sync reports everything unchanged and no orphans", async () => {
    const sql = getTestSql();
    await syncModuleDescriptors(sql);

    const existingRows = await fetchExistingModules(sql);
    const plan = planModuleSync(listModules(), existingRows);

    expect(plan.entries.every((entry) => entry.action === "unchanged")).toBe(
      true
    );
    expect(plan.orphanedModuleKeys).toEqual([]);
  });

  test("advisory lock: two concurrent runJob-wrapped syncs for the same job name — only one actually invokes syncModuleDescriptors, the other skips, never both mutating at once", async () => {
    const sql = getTestSql();
    let invocationCount = 0;

    const jobDefinition = {
      name: "modules:sync",
      description: "test",
      handler: async () => {
        invocationCount += 1;
        // Hold the lock for a bit so the second concurrent attempt
        // genuinely has to contend for it, rather than the first
        // finishing before the second even starts.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const syncResult = await syncModuleDescriptors(sql);
        return { itemCounts: { created: syncResult.created.length } };
      }
    };

    const [first, second] = await Promise.all([
      runJob(jobDefinition, { sql }),
      runJob(jobDefinition, { sql })
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["skipped", "success"]);
    expect(invocationCount).toBe(1);
    expect(await countModuleRows()).toBe(listModules().length);
  });
});
