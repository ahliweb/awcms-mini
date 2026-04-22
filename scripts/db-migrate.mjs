import { createDatabase } from "../src/db/client/postgres.mjs";
import { formatDatabaseErrorDiagnostic } from "../src/db/errors.mjs";
import {
  ensureMigrationBootstrap,
  formatMigrationResults,
  getEmdashMigrationStatus,
  getMigrationStatus,
  migrateDown,
  migrateToLatest,
  NO_MIGRATIONS,
  repairEmdashMigrationLedger,
  verifyEmdashMigrationStatus,
} from "../src/db/migrations/runner.mjs";
import { loadLocalEnvFiles } from "./_local-env.mjs";

function printUsage() {
  console.log("Usage: node scripts/db-migrate.mjs <latest|down|status|emdash-status|emdash-verify|emdash-repair>");
}

function printDatabaseError(error) {
  const diagnostic = formatDatabaseErrorDiagnostic(error);

  console.error(`Database error kind: ${diagnostic.kind}`);
  console.error(`Database error reason: ${diagnostic.reason}`);
  console.error(`Database error message: ${diagnostic.message}`);
}

function printEmdashStatus(status) {
  console.log(`Applied: ${status.applied.length}`);
  status.applied.forEach((name) => console.log(`  applied ${name}`));
  console.log(`Pending: ${status.pending.length}`);
  status.pending.forEach((name) => console.log(`  pending ${name}`));
  console.log(`Compatibility state: ${status.repair.state}`);

  status.repair.analysis.mismatches.forEach((mismatch) => {
    console.log(`  mismatch index=${mismatch.index} expected=${mismatch.expected} actual=${mismatch.actual}`);
  });

  status.repair.analysis.unexpected.forEach((name) => {
    console.log(`  unexpected ${name}`);
  });

  if (status.repair.state === "repairable") {
    console.log("  repair action: rewrite _emdash_migrations into the canonical Mini compatibility prefix order");
  }
}

async function main() {
  loadLocalEnvFiles();

  const command = process.argv[2];

  if (!command || !["latest", "down", "status", "emdash-status", "emdash-verify", "emdash-repair"].includes(command)) {
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

    if (command === "emdash-status") {
      const status = await getEmdashMigrationStatus(db);
      printEmdashStatus(status);
      return;
    }

    if (command === "emdash-verify") {
      const status = await getEmdashMigrationStatus(db);
      printEmdashStatus(status);

      try {
        verifyEmdashMigrationStatus(status);
        console.log("EmDash compatibility verified.");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }

      return;
    }

    if (command === "emdash-repair") {
      const outcome = await repairEmdashMigrationLedger(db);
      const status = await getEmdashMigrationStatus(db);
      printEmdashStatus(status);
      console.log(outcome.changed ? "Repair applied." : "Repair not applied.");

      if (outcome.repair.state === "unsafe") {
        process.exitCode = 1;
      }

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
  printDatabaseError(error);
  process.exit(1);
});
