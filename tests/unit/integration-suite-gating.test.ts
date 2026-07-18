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
 * WHAT COUNTS AS GATED. A top-level (column-0) describe invocation is
 * acceptable only in a form that is skipped when the DB is absent:
 *   - `suite(...)`                    — the canonical gate helper
 *   - `describe.skip(...)`            — unconditional skip
 *   - `describe.skipIf(!integrationEnabled)(...)` — conditional skip
 * A bare `describe(...)` or `describe.only(...)` at column 0 is a
 * violation: the former runs unconditionally, the latter also silences
 * every sibling suite. Nested/indented `describe(...)` inside an
 * already-gated block is fine and intentionally not inspected — only
 * column-0 invocations decide whether a file body runs at all.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const INTEGRATION_DIR = path.join(REPO_ROOT, "tests/integration");

/** A column-0 describe call that is NOT one of the gated forms. */
const BARE_TOP_LEVEL_DESCRIBE = /^describe\s*(?:\.only)?\s*\(/;

function listIntegrationFiles(): string[] {
  return readdirSync(INTEGRATION_DIR)
    .filter((name) => name.endsWith(".integration.test.ts"))
    .sort();
}

function findBareDescribes(source: string): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (BARE_TOP_LEVEL_DESCRIBE.test(line)) {
      offenders.push({ line: index + 1, text: line.trim() });
    }
  });
  return offenders;
}

describe("integration suites are gated on DATABASE_URL (Issue #858)", () => {
  test("no integration file has a bare top-level describe() block", () => {
    const files = listIntegrationFiles();
    // Guard against a broken scanner silently passing (e.g. wrong dir).
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    for (const name of files) {
      const source = readFileSync(path.join(INTEGRATION_DIR, name), "utf8");
      for (const { line, text } of findBareDescribes(source)) {
        violations.push(`  tests/integration/${name}:${line}: ${text}`);
      }
    }

    expect(
      violations,
      violations.length === 0
        ? ""
        : "Ungated top-level describe() found in integration test file(s).\n" +
            "Every top-level block must be skipped when DATABASE_URL is unset,\n" +
            "otherwise `bun run check` / `bun test` fails without a database.\n" +
            "Replace the bare `describe(` with the file's `suite` gate helper\n" +
            "(`const suite = integrationEnabled ? describe : describe.skip;`),\n" +
            "or `describe.skipIf(!integrationEnabled)(...)`. Offending lines:\n" +
            violations.join("\n")
    ).toEqual([]);
  });
});
