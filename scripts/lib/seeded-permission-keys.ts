/**
 * Collect the set of `module_key.activity_code.action` permission keys actually
 * SEEDED by the SQL migrations (`INSERT INTO awcms_mini_permissions`). Used by
 * the SoD registry gate (Issue #879) to prove every rule's conflicting
 * permission keys point at a real, seeded permission — the true seed source,
 * since some Core modules (identity_access, logging) seed permissions in SQL
 * without a descriptor `permissions` array.
 *
 * Pure file reads, no database. The first three columns of every
 * `awcms_mini_permissions` INSERT tuple are simple single-quoted identifiers
 * with no embedded commas/quotes, so a tuple-prefix match is exact and cannot be
 * fooled by a description string that contains commas or escaped quotes.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQL_DIR = path.join(HERE, "..", "..", "sql");

/** Extract `(module, activity, action, ...)` triples from every permission INSERT. */
export function collectSeededPermissionKeysFromSql(
  sqlDir: string = DEFAULT_SQL_DIR
): Set<string> {
  const keys = new Set<string>();
  const files = readdirSync(sqlDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const insertHeader = /insert\s+into\s+awcms_mini_permissions\b/gi;
  const tuple =
    /\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'/gi;

  for (const file of files) {
    const sql = readFileSync(path.join(sqlDir, file), "utf8");
    let header: RegExpExecArray | null;
    insertHeader.lastIndex = 0;
    while ((header = insertHeader.exec(sql)) !== null) {
      // Scan the statement body up to the STATEMENT-terminating ';', honoring
      // single-quoted strings (a ';' INSIDE a description literal — e.g.
      // "(activate; concurrency-safe)" — must NOT truncate the statement).
      let end = sql.length;
      let inString = false;
      for (let j = header.index; j < sql.length; j++) {
        const ch = sql[j]!;
        if (inString) {
          if (ch === "'") {
            if (sql[j + 1] === "'") j++;
            else inString = false;
          }
          continue;
        }
        if (ch === "'") inString = true;
        else if (ch === ";") {
          end = j;
          break;
        }
      }
      const body = sql.slice(header.index, end);
      tuple.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = tuple.exec(body)) !== null) {
        keys.add(`${m[1]}.${m[2]}.${m[3]}`);
      }
    }
  }

  return keys;
}
