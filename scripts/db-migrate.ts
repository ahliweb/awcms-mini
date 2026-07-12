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
 * Single left-to-right, character-by-character pass that removes every SQL
 * span which must never be scanned for top-level transaction-control
 * keywords: line comments (`-- ...`), block comments (`/* ... *&#47;`,
 * correctly NESTING per Postgres's own comment rules — unlike most SQL
 * dialects), dollar-quoted bodies (`$$...$$`/`$tag$...$tag$`), single-quoted
 * string literals (including `E'...'`/`e'...'` backslash-escape strings),
 * and double-quoted identifiers.
 *
 * This is a hand-written state-machine scanner, not a regex, after TWO
 * rounds of regex-based fixes on this same function both got independently
 * broken by a reviewer/security-auditor re-audit on PR #723:
 *   round 1 (sequential stripDollarQuotedBlocks + stripSingleQuotedStringLiterals):
 *     an apostrophe inside a `--` comment or a double-quoted identifier
 *     could pair with a later, unrelated quote and bracket away a real
 *     ROLLBACK;/COMMIT;/BEGIN; (e.g. `-- don't do this\nROLLBACK;`,
 *     `CREATE TABLE "peter's_table" ...; COMMIT;`).
 *   round 2 (single alternation regex, still bypassable): a lone stray
 *     apostrophe in a comment could still pair with an unrelated LATER
 *     string literal across the whole file (the reviewer's exact repro:
 *     `-- it's fine...\nROLLBACK;\nSELECT 'foo';`) — fixed by treating each
 *     comment as one opaque token, but regex alternation still can't
 *     express NESTING (Postgres block comments nest) or STATEFUL escaping
 *     (`E'...'` strings interpret backslash-escapes, plain `'...'` strings
 *     don't) — both independently found bypassable by the reviewer:
 *     `/* outer /* inner *&#47; still nested *&#47;\nROLLBACK;` (the regex's
 *     non-nesting `\/\*[\s\S]*?\*\/` stops at the FIRST `*&#47;`, leaving a
 *     stray `it's`-shaped apostrophe to reopen the same bracketing bug), and
 *     `SELECT E'it\'s escaped';\nROLLBACK;` (the regex doesn't know `\'`
 *     doesn't close an `E'...'` string, so it closes early on the escaped
 *     quote, again leaving a stray apostrophe).
 *
 * A real single-pass STATE MACHINE (this function) closes all of the above
 * by construction rather than by enumerating more adversarial cases: at
 * every position there is exactly one active mode (top-level / line
 * comment / block comment at some nesting depth / single-quoted string,
 * optionally escape-aware / double-quoted identifier / dollar-quoted block
 * with a specific tag), and each mode's own closing rule is applied
 * correctly (nesting depth for block comments, backslash-awareness only for
 * `E`/`e`-prefixed strings, `''`/`""` doubling for both string and
 * identifier quoting) — there is no independent second pass that could ever
 * misread one mode's delimiter as another's.
 */
/**
 * Postgres word-continuation characters for a bare (unquoted) identifier —
 * letters, digits, underscore. `$` and `E`/`e` are both valid NON-FIRST
 * characters of a bare identifier (e.g. `name`, `date`, `col$1`) AND are
 * also this scanner's own prefix markers for dollar-quoting and
 * escape-strings respectively — so a maximal-munch identifier like `name`
 * immediately followed by `'...'` must NOT have its trailing `e` reread as
 * a fresh `E'...'` prefix. Security-auditor finding (PR #723, round 3):
 * without this guard, `name'trap\';\nROLLBACK;\nSELECT 'trailer';` was
 * misparsed — the trailing `e` of `name` was treated as an escape-string
 * prefix, so the backslash-escape rule consumed past the real closing
 * quote and silently swallowed the genuine top-level `ROLLBACK;`.
 */
function isIdentifierContinuationChar(ch: string): boolean {
  // Unicode-aware (`\p{L}`, not just A-Za-z): security-auditor round-3
  // follow-up — Postgres bare identifiers may continue with any Unicode
  // letter, not only ASCII, so an ASCII-only check would still misread a
  // non-ASCII-lettered identifier (e.g. `cafée'...'`) as a fresh E-string
  // prefix. No migration in this repo uses non-ASCII identifiers today —
  // this closes the gap opportunistically rather than leaving it as a
  // documented residual. Also includes `$` (round-4 reviewer finding): `$`
  // is a valid NON-FIRST character of a bare Postgres identifier (e.g.
  // `col$1`), so `price$e'\';` was still misread as a fresh escape-string
  // prefix without it — same root cause as the letter/digit/underscore
  // cases, just one more character in the same real grammar.
  return /[\p{L}0-9_$]/u.test(ch);
}

export function stripNonExecutableSqlSpans(sql: string): string {
  let output = "";
  const n = sql.length;
  let i = 0;
  /**
   * Tracks whether the character immediately behind the current scan
   * position was itself part of an ONGOING plain bare-identifier scan —
   * NOT merely "the raw character happens to match the identifier-
   * continuation class." Reviewer round-5 finding: a single-character
   * lookback at raw `sql[i-1]` text can't distinguish "this `$` is mid-
   * identifier" from "this `$` is the closing delimiter of an
   * already-COMPLETE dollar-quoted token" — both look identical as raw
   * text, but only the former is a real token-continuation in Postgres's
   * own lexer. `$$body$$E'it\'s a value';` is two independent, back-to-
   * back tokens (a complete dollar-quoted string, then a fresh
   * `E'...'` escape-string) — the previous version misread the
   * dollar-quote's own closing `$` as if it were still building an
   * identifier, so it wrongly suppressed the genuine `E'...'` escape
   * parsing, mis-closed the string early, and swallowed a real top-level
   * `ROLLBACK;` after it. Explicitly resetting this flag to `false` at
   * every point a special token (comment/dollar-quote/string/identifier)
   * finishes — regardless of what its last raw character happened to be —
   * closes this by construction: only a plain, uninterrupted run of
   * identifier-continuation characters ever leaves it `true`.
   */
  let precededByIdentifierChar = false;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      precededByIdentifierChar = false;
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      precededByIdentifierChar = false;
      continue;
    }

    if (ch === "$" && !precededByIdentifierChar) {
      const tagMatch = /^\$\w*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIndex = sql.indexOf(tag, i + tag.length);
        if (closeIndex !== -1) {
          i = closeIndex + tag.length;
          precededByIdentifierChar = false;
          continue;
        }
      }
    }

    const isEscapeStringPrefix =
      (ch === "E" || ch === "e") && next === "'" && !precededByIdentifierChar;

    if (isEscapeStringPrefix || ch === "'") {
      i += isEscapeStringPrefix ? 2 : 1;
      while (i < n) {
        if (isEscapeStringPrefix && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      precededByIdentifierChar = false;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      precededByIdentifierChar = false;
      continue;
    }

    output += ch;
    precededByIdentifierChar = isIdentifierContinuationChar(ch ?? "");
    i++;
  }

  return output;
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
