import { createDatabase } from "../src/db/client/postgres.mjs";
import {
  ensureMigrationBootstrap,
  formatMigrationResults,
  getMigrationStatus,
  migrateDown,
  migrateToLatest,
  NO_MIGRATIONS,
} from "../src/db/migrations/runner.mjs";
import { loadLocalEnvFiles } from "./_local-env.mjs";

function printUsage() {
  console.log("Usage: node scripts/db-migrate.mjs <latest|down|status>");
}

async function main() {
  loadLocalEnvFiles();

  const command = process.argv[2];

  if (!command || !["latest", "down", "status"].includes(command)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const db = createDatabase();

  try {
    await ensureMigrationBootstrap(db);

    if (command === "status") {
      const status = await getMigrationStatus(db);
      console.log(`Applied: ${status.applied.length}`);
      status.applied.forEach((name) => console.log(`  applied ${name}`));
      console.log(`Pending: ${status.pending.length}`);
      status.pending.forEach((name) => console.log(`  pending ${name}`));
      return;
    }

    const outcome = command === "latest" ? await migrateToLatest(db) : await migrateDown(db);
    const results = outcome.results ?? [];

    formatMigrationResults(results).forEach((line) => console.log(line));

    if (outcome.error) {
      console.error(outcome.error);
      process.exitCode = 1;
      return;
    }

    if (results.length === 0 && command === "down") {
      console.log(NO_MIGRATIONS);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
