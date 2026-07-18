/**
 * Integration-suite gating gate (Issue #858, part of the #818 post-audit
 * hardening epic).
 *
 * WHY THIS FILE EXISTS. Every `tests/integration/*.integration.test.ts`
 * file is designed to SKIP its entire body when `DATABASE_URL` is unset —
 * that is what lets `bun run check` / `bun test` pass locally without a
 * Postgres. The mechanism is a per-file gate helper, canonically:
 *
 *   const suite = integrationEnabled ? describe : describe.skip;
 *
 * and then every top-level block uses `suite(...)` (or, equivalently,
 * `describe.skipIf(!integrationEnabled)(...)`). #858 was a single block in
 * `reference-data.integration.test.ts` that slipped back to a BARE,
 * ungated `describe(...)`. That block ran unconditionally, so its ten
 * DB-touching tests failed the moment `bun run check` was run without
 * `DATABASE_URL`. CI never caught it because the Quality job always sets
 * `DATABASE_URL` — the exact blind spot a green CI cannot see.
 *
 * Fixing that one line alone would only delay the next occurrence: nothing
 * compared each integration file's top-level blocks against the gating
 * convention. This gate does. A single bare top-level `describe(` in any
 * integration file now fails loudly here — a PURE unit test with no DB
 * dependency, so it runs (and can catch the regression) precisely in the
 * DATABASE_URL-less environment the integration suites hide from.
 *
 * WHAT COUNTS AS GATED — DEFAULT-DENY ALLOW-LIST. The detector does NOT
 * enumerate the bad forms (a deny-list of `describe(` / `describe.only(`
 * would silently let a novel top-level variant like
 * `describe.each([...])(...)` or `describe.todo(...)` through — it runs
 * unconditionally just the same). Instead it flags EVERY column-0
 * `describe...` invocation and EXEMPTS only the two forms that are
 * genuinely skipped when the DB is absent:
 *   - `describe.skip(...)`            — unconditional skip
 *   - `describe.skipIf(!integrationEnabled)(...)` — conditional skip
 * The canonical `suite(...)` helper (`suite = integrationEnabled
 * ? describe : describe.skip`) never starts with `describe`, so it is
 * inherently outside the detector's net. Everything else at column 0 —
 * `describe(`, `describe.only(`, `describe.each(`, `describe.todo(`, … —
 * is a violation, because it decides whether a file body runs and does so
 * WITHOUT consulting `integrationEnabled`.
 *
 * Nested/indented `describe(...)` inside an already-gated block is fine
 * and intentionally not inspected — only column-0 invocations decide
 * whether a file body runs at all. Lines whose first non-space character
 * begins a block comment (` * ...`) never start at column 0 with
 * `describe`, so prose examples are not matched.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const INTEGRATION_DIR = path.join(REPO_ROOT, "tests/integration");

/** Any column-0 `describe...` invocation (the whole family). */
const TOP_LEVEL_DESCRIBE = /^describe\b/;
/** The ONLY exempt forms: `describe.skip(` and `describe.skipIf(`. */
const GATED_DESCRIBE = /^describe\.skip(?:If)?\s*\(/;

function listIntegrationFiles(): string[] {
  return readdirSync(INTEGRATION_DIR)
    .filter((name) => name.endsWith(".integration.test.ts"))
    .sort();
}

function findUngatedDescribes(
  source: string
): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (TOP_LEVEL_DESCRIBE.test(line) && !GATED_DESCRIBE.test(line)) {
      offenders.push({ line: index + 1, text: line.trim() });
    }
  });
  return offenders;
}

describe("integration suites are gated on DATABASE_URL (Issue #858)", () => {
  test("no integration file has an ungated top-level describe block", () => {
    const files = listIntegrationFiles();
    // Guard against a broken scanner silently passing (e.g. wrong dir).
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    for (const name of files) {
      const source = readFileSync(path.join(INTEGRATION_DIR, name), "utf8");
      for (const { line, text } of findUngatedDescribes(source)) {
        violations.push(`  tests/integration/${name}:${line}: ${text}`);
      }
    }

    expect(
      violations,
      violations.length === 0
        ? ""
        : "Ungated top-level describe block found in integration test file(s).\n" +
            "Every top-level block must be skipped when DATABASE_URL is unset,\n" +
            "otherwise `bun run check` / `bun test` fails without a database.\n" +
            "Only `describe.skip(...)` and `describe.skipIf(!integrationEnabled)(...)`\n" +
            "are exempt; use the file's `suite` gate helper instead\n" +
            "(`const suite = integrationEnabled ? describe : describe.skip;`).\n" +
            "This includes `describe(`, `describe.only(`, `describe.each(`,\n" +
            "and `describe.todo(`. Offending lines:\n" +
            violations.join("\n")
    ).toEqual([]);
  });
});
