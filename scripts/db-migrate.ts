/**
 * CLI migration runner: `bun scripts/db-migrate.ts [latest|status]`.
 * Exit non-zero bila gagal (doc 16).
 */
import { join } from "node:path";
import { getSql, closeSql } from "../src/lib/database/db";
import {
  loadMigrationFiles,
  migrateLatest,
  planMigrations,
  readLedger
} from "../src/lib/database/migrations";

const SQL_DIR = join(import.meta.dirname, "..", "sql");

async function main(): Promise<void> {
  const command = process.argv[2] ?? "latest";
  const sql = getSql();

  if (command === "status") {
    const plan = planMigrations(await loadMigrationFiles(SQL_DIR), await readLedger(sql));
    for (const name of plan.applied) console.log(`applied  ${name}`);
    for (const file of plan.pending) console.log(`pending  ${file.name}`);
    for (const drift of plan.drifted) console.log(`DRIFT    ${drift.name}`);
    if (plan.drifted.length > 0) process.exitCode = 1;
    return;
  }

  if (command === "latest") {
    const result = await migrateLatest(sql, SQL_DIR);
    for (const name of result.skipped) console.log(`skip     ${name}`);
    for (const name of result.executed) console.log(`migrate  ${name}`);
    if (result.executed.length === 0) console.log("Database sudah up-to-date.");
    return;
  }

  throw new Error(`Perintah tidak dikenal: ${command} (gunakan latest|status)`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeSql());
