import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileMigrationProvider, Migrator, NO_MIGRATIONS, sql } from "kysely";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = __dirname;

export function createMigrator(db) {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });
}

export async function migrateToLatest(db) {
  return createMigrator(db).migrateToLatest();
}

export async function migrateDown(db) {
  return createMigrator(db).migrateDown();
}

export async function getMigrationStatus(db) {
  const files = (await fs.readdir(migrationFolder))
    .filter((name) => name !== "runner.mjs")
    .filter((name) => /\.(mjs|js)$/.test(name))
    .map((name) => name.replace(/\.(mjs|js)$/, ""))
    .sort();

  let rows;

  try {
    rows = await db
      .selectFrom("kysely_migration")
      .select(["name"])
      .orderBy("name", "asc")
      .execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes('relation "kysely_migration" does not exist')) {
      throw error;
    }

    return {
      applied: [],
      pending: files,
    };
  }

  const applied = rows.map((row) => row.name);
  const appliedSet = new Set(applied);

  return {
    applied,
    pending: files.filter((name) => !appliedSet.has(name)),
  };
}

export function formatMigrationResults(results = []) {
  if (results.length === 0) {
    return ["No migration changes were applied."];
  }

  return results.map((result) => {
    if (result.status === "Success") {
      return `SUCCESS ${result.migrationName}`;
    }

    if (result.status === "Error") {
      return `ERROR ${result.migrationName}`;
    }

    return `${result.status.toUpperCase()} ${result.migrationName}`;
  });
}

export async function ensureMigrationBootstrap(db) {
  // Touch the connection early so connection failures are clear before command work.
  await sql`select 1`.execute(db);
}

export { NO_MIGRATIONS };
