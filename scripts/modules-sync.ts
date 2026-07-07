/**
 * modules-sync.ts — `bun run modules:sync`.
 *
 * Issue #513 (epic #510, Module Management). CLI wrapper for
 * `syncModuleDescriptors` (`src/modules/module-management/application/
 * descriptor-sync.ts`) — reads the trusted code registry (`listModules()`)
 * and upserts it into the database-backed registry. Safe to run on every
 * deploy (idempotent, no network calls, no user input).
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { syncModuleDescriptors } from "../src/modules/module-management/application/descriptor-sync";

async function main() {
  const sql = getDatabaseClient();

  try {
    const result = await syncModuleDescriptors(sql);

    console.log(
      `modules:sync complete — created=${result.created.length} ` +
        `updated=${result.updated.length} unchanged=${result.unchanged.length} ` +
        `orphaned=${result.orphaned.length}`
    );

    if (result.created.length > 0) {
      console.log(`  created: ${result.created.join(", ")}`);
    }
    if (result.updated.length > 0) {
      console.log(`  updated: ${result.updated.join(", ")}`);
    }
    if (result.orphaned.length > 0) {
      console.log(
        `  orphaned (marked disabled, not deleted): ${result.orphaned.join(", ")}`
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`modules:sync FAILED — ${detail}`);
    process.exitCode = 1;
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
