import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { redactSecretsInText } from "../src/modules/_shared/redaction";

export type MigrationFile = {
  name: string;
  path: string;
  sql: string;
  checksum: string;
};

export type AppliedMigration = {
  migration_name: string;
  checksum: string | null;
};

type MigrationResult = {
  applied: string[];
  skipped: string[];
};

const MIGRATION_FILE_PATTERN = /^\d{3}_awcms_mini_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = 975_202_601_372;
const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS awcms_mini_schema_migrations (
  id bigserial PRIMARY KEY,
  migration_name text NOT NULL UNIQUE,
  checksum text,
  executed_at timestamptz NOT NULL DEFAULT now()
)`;

export function computeMigrationChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

export function redactDatabaseUrl(input: string, databaseUrl: string): string {
  if (!databaseUrl) {
    return input;
  }

  const urlWithMaskedPassword = maskUrlPassword(databaseUrl);

  return input
    .split(databaseUrl)
    .join("[redacted DATABASE_URL]")
    .split(urlWithMaskedPassword)
    .join("[redacted DATABASE_URL]");
}

export function stripOptionalTransactionWrapper(sql: string): string {
  return sql
    .trim()
    .replace(/^(BEGIN|START\s+TRANSACTION)\s*;\s*/i, "")
    .replace(/\s*(COMMIT|ROLLBACK)\s*;\s*$/i, "")
    .trim();
}

/**
 * Removes dollar-quoted string bodies (`$$ ... $$`, `$tag$ ... $tag$`) so their
 * contents are not scanned for transaction-control keywords. A PL/pgSQL block
 * (`DO $$ BEGIN ... END $$`) legitimately contains `BEGIN`/`END`, which are
 * block delimiters, not the top-level `BEGIN;`/`COMMIT;` transaction control
 * this check is meant to reject.
 */
export function stripDollarQuotedBlocks(sql: string): string {
  return sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "");
}

/**
 * Removes the contents of standard single-quoted SQL string literals (e.g.
 * `'rollback'`), honoring the standard `''`-escaped-quote-within-a-string
 * convention, so an ordinary data value is never scanned for
 * transaction-control keywords. Discovered by Issue #655's own permission
 * seed migration (048): a plain `INSERT ... VALUES (...)` row whose
 * `action` column value is literally `'rollback'` (required verbatim by the
 * issue itself — the permission key `idn_admin_regions.dataset.rollback`)
 * was a false positive for `assertNoTransactionControl` before this fix,
 * because the word "rollback" appeared inside a quoted string literal, not
 * as a top-level `ROLLBACK;` statement. Must run AFTER
 * `stripDollarQuotedBlocks` — a dollar-quoted PL/pgSQL body may itself
 * contain single-quoted string literals, and stripping the dollar-quoted
 * span first removes them along with everything else in that span, so
 * this function only ever needs to consider genuinely top-level SQL text.
 */
export function stripSingleQuotedStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Single left-to-right pass that removes every SQL span that must never be
 * scanned for top-level transaction-control keywords: line comments
 * (`-- ...`), block comments (`/* ... *&#47;`), dollar-quoted bodies
 * (`$$...$$`/`$tag$...$tag$`), single-quoted string literals, and
 * double-quoted identifiers — in ONE combined regex, not a sequence of
 * independent full-text passes.
 *
 * Security-auditor Critical finding on PR #723: chaining
 * `stripDollarQuotedBlocks` then `stripSingleQuotedStringLiterals` as two
 * INDEPENDENT full-text scans let an apostrophe belonging to a `--` comment
 * (an ordinary English contraction like "don't"/"won't") or to a
 * double-quoted identifier (`"peter's_table"`) get misread by the
 * string-literal regex as a string delimiter — bracketing, and silently
 * deleting, a genuine top-level `ROLLBACK;`/`COMMIT;`/`BEGIN;` sitting
 * between them before the keyword scan ever saw it. Empirically confirmed
 * bypassable via:
 *   -- don't do this
 *   ROLLBACK;
 *   -- won't stop
 * and:
 *   CREATE TABLE "peter's_table" (id int);
 *   COMMIT;
 * A single alternation regex closes this: the left-to-right scan advances
 * to whichever token's own opening delimiter occurs first, and that
 * alternative alone consumes all the way to ITS OWN closing delimiter — an
 * apostrophe inside a comment or a double-quoted identifier is never
 * separately visible to the string-literal alternative at all, so it can
 * never be mistaken for one.
 */
export function stripNonExecutableSqlSpans(sql: string): string {
  return sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|\$(\w*)\$[\s\S]*?\$\1\$|'(?:[^']|'')*'|"(?:[^"]|"")*"/g,
    ""
  );
}

export function assertNoTransactionControl(sql: string, migrationName: string) {
  if (
    /\b(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i.test(
      stripNonExecutableSqlSpans(sql)
    )
  ) {
    throw new Error(
      `Migration ${migrationName} contains transaction control statements. ` +
        "Let scripts/db-migrate.ts manage the transaction boundary."
    );
  }
}

export async function discoverMigrationFiles(
  migrationsDir = path.resolve(process.cwd(), "sql")
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const invalidFile = fileNames.find(
    (fileName) => !MIGRATION_FILE_PATTERN.test(fileName)
  );

  if (invalidFile) {
    throw new Error(
      `Invalid migration file name: ${invalidFile}. ` +
        "Use NNN_awcms_mini_<area>_<description>.sql."
    );
  }

  const migrations = await Promise.all(
    fileNames.map(async (name) => {
      const migrationPath = path.join(migrationsDir, name);
      const rawSql = await readFile(migrationPath, "utf8");
      const sql = stripOptionalTransactionWrapper(rawSql);

      assertNoTransactionControl(sql, name);

      return {
        name,
        path: migrationPath,
        sql,
        checksum: computeMigrationChecksum(sql)
      };
    })
  );

  return migrations;
}

export function validateAppliedChecksums(
  migrations: MigrationFile[],
  appliedMigrations: AppliedMigration[]
) {
  const appliedByName = new Map(
    appliedMigrations.map((migration) => [
      migration.migration_name,
      migration.checksum
    ])
  );

  for (const migration of migrations) {
    const appliedChecksum = appliedByName.get(migration.name);

    if (appliedChecksum && appliedChecksum !== migration.checksum) {
      throw new Error(
        `Checksum mismatch for applied migration ${migration.name}. ` +
          "Create a new migration instead of editing an applied one."
      );
    }
  }
}

async function runMigrations(
  sql: Bun.SQL,
  migrations: MigrationFile[]
): Promise<MigrationResult> {
  await sql.unsafe(MIGRATION_TABLE_SQL);
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;

  try {
    const appliedRows = await sql<AppliedMigration[]>`
      SELECT migration_name, checksum
      FROM awcms_mini_schema_migrations
      ORDER BY migration_name ASC
    `;

    validateAppliedChecksums(migrations, appliedRows);

    const appliedByName = new Set(
      appliedRows.map((migration) => migration.migration_name)
    );
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      if (appliedByName.has(migration.name)) {
        skipped.push(migration.name);
        continue;
      }

      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO awcms_mini_schema_migrations (migration_name, checksum)
          VALUES (${migration.name}, ${migration.checksum})
        `;
      });

      applied.push(migration.name);
    }

    return { applied, skipped };
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
  }
}

function maskUrlPassword(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);

    if (url.password) {
      url.password = "****";
    }

    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  if (!databaseUrl.startsWith("postgres://")) {
    throw new Error("DATABASE_URL must use the postgres:// protocol.");
  }

  return databaseUrl;
}

function safeErrorMessage(error: unknown, databaseUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);

  // Issue #687 — `redactDatabaseUrl` only ever masked *this run's own*
  // `DATABASE_URL` value; `redactSecretsInText` additionally catches any
  // other credential-shaped substring a driver error might echo back (a
  // JWT, a different connection string, a `password=`-style fragment)
  // that isn't literally this process's own `databaseUrl`.
  return redactSecretsInText(redactDatabaseUrl(message, databaseUrl));
}

async function main() {
  let databaseUrl = "";
  let sql: Bun.SQL | undefined;

  try {
    databaseUrl = getDatabaseUrl();
    sql = new Bun.SQL(databaseUrl, { max: 1 });

    const migrations = await discoverMigrationFiles();
    const result = await runMigrations(sql, migrations);

    for (const name of result.skipped) {
      console.log(`skip ${name}`);
    }

    for (const name of result.applied) {
      console.log(`apply ${name}`);
    }

    console.log(
      `db:migrate complete — ${result.applied.length} applied, ${result.skipped.length} skipped`
    );
  } catch (error) {
    console.error(
      `db:migrate failed — ${safeErrorMessage(error, databaseUrl)}`
    );
    process.exitCode = 1;
  } finally {
    await sql?.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
