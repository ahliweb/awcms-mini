/**
 * Module <-> planning-doc reconciliation gate (Issue #828, part of the
 * #818 post-audit hardening epic).
 *
 * WHY THIS FILE EXISTS. Issue #828 found the planning docs (01, 02, 13)
 * badly behind the code: doc 01's "Modul utama (base)" table listed 11
 * rows against a 23-module registry and asserted "modul domain ... bukan
 * bagian base ini" while `src/modules/index.ts` registers `blog_content`,
 * `news_portal` and `social_publishing` as base; doc 13's migration matrix
 * stopped at `055` and omitted seven modules; doc 21's §8 table is headed
 * "Peta 23 modul" but carried 22 rows.
 *
 * None of that is "someone forgot". It is that NOTHING compared these
 * hand-written tables against the registry they claim to describe. This is
 * the same root cause `tests/unit/module-skill-coverage.test.ts` (Issue
 * #829) was written for one issue earlier, and the same recurring
 * skill/doc-drift class now on its seventh confirmed occurrence. Editing
 * the numbers without a gate buys occurrence number eight — so this gate,
 * not the doc edits, is what #828 is actually for.
 *
 * WHAT IT ENFORCES. Three hand-written tables must stay a faithful
 * projection of two machine-readable ground truths — `listBaseModules()`
 * and the `sql/` directory:
 *
 *   1. doc 01 §"Modul utama (base)"            -> exactly the registry keys
 *   2. doc 13 §"Matrix Modul vs Migration"     -> exactly the registry keys,
 *                                                 AND exactly the real `sql/` files
 *   3. doc 21 §8 classification table          -> exactly the registry keys
 *
 * PARSES STATEMENTS, NOT PROSE. Every check below extracts the actual
 * MARKDOWN TABLE ROWS under a named heading and reads the backticked key
 * out of the first column. It deliberately does NOT do
 * `docText.includes(key)`: all three documents discuss module keys in
 * surrounding prose, so an `includes()` gate would be satisfied by a
 * sentence merely mentioning a module and would stay green with the table
 * row still missing. That "prose satisfies the gate" defect has bitten
 * this repo before; a row must exist as a ROW to count here.
 *
 * NOT DERIVED FROM DIRECTORY NAMES. Keys come from `listBaseModules()`,
 * never from `src/modules/<dir>`. The registered key for
 * `src/modules/workflow-approval` really is `workflow`, so a
 * directory-derived key would silently match nothing and pass vacuously.
 *
 * SCOPE. Base registry only, matching `module-skill-coverage.test.ts`'s
 * reasoning: a derived application contributing modules via
 * `application-registry.ts` (Issue #740) does not appear in THIS
 * repository's planning docs, so `listBaseModules()` is the correct ground
 * truth, not `listModules()`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { listBaseModules } from "../../src/modules";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const DOC_01 = path.join(REPO_ROOT, "docs/awcms-mini/01_canvas_induk.md");
const DOC_13 = path.join(
  REPO_ROOT,
  "docs/awcms-mini/13_final_master_index_traceability.md"
);
const DOC_21 = path.join(
  REPO_ROOT,
  "docs/awcms-mini/21_module_admission_governance.md"
);

const baseModuleKeys = listBaseModules().map((module) => module.key);

/**
 * Return the rows of the FIRST Markdown table that follows `heading`,
 * stopping at the next heading of the same-or-higher level so a later
 * table in the document can never be picked up by accident.
 *
 * Each returned row is the list of trimmed cells. The header row and the
 * `|---|---|` separator are dropped.
 */
function tableRowsUnderHeading(file: string, heading: string): string[][] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    throw new Error(
      `Heading "${heading}" not found in ${path.relative(REPO_ROOT, file)}. ` +
        `This gate pins that heading — if it was renamed, update this test ` +
        `deliberately rather than deleting the check.`
    );
  }

  const headingLevel = (/^#+/.exec(heading)?.[0] ?? "#").length;
  const rows: string[][] = [];
  let seenTable = false;

  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();

    // Stop at the next heading of the same or higher level.
    const nextHeading = /^(#+)\s/.exec(trimmed);
    if (nextHeading && (nextHeading[1]?.length ?? 0) <= headingLevel) {
      break;
    }

    if (trimmed.startsWith("|")) {
      seenTable = true;
      // Separator row (|---|:--:|) carries no data.
      if (/^\|[\s:|-]+\|$/.test(trimmed)) {
        continue;
      }
      const cells = trimmed
        .slice(1, trimmed.endsWith("|") ? -1 : undefined)
        .split("|")
        .map((cell) => cell.trim());
      rows.push(cells);
      continue;
    }

    // A blank line inside a table is the table's end; prose after the
    // table is fine, but a second table must not be appended.
    if (seenTable && trimmed === "") {
      break;
    }
  }

  if (rows.length === 0) {
    throw new Error(
      `No Markdown table found under "${heading}" in ${path.relative(REPO_ROOT, file)}.`
    );
  }

  // Drop the header row.
  return rows.slice(1);
}

/**
 * The backticked identifier in a row's first column, or null when that
 * column holds something else (doc 13's `_(Foundation, lintas-modul)_`
 * row, which maps genuinely cross-module migrations to no single module).
 */
function keyFromFirstColumn(row: string[]): string | null {
  const match = /^`([a-z0-9_]+)`$/.exec(row[0] ?? "");
  return match?.[1] ?? null;
}

function keysFromTable(file: string, heading: string): string[] {
  return tableRowsUnderHeading(file, heading)
    .map(keyFromFirstColumn)
    .filter((key): key is string => key !== null);
}

/** Sorted set difference helpers — keep failure messages readable. */
function missing(expected: readonly string[], actual: readonly string[]) {
  const have = new Set(actual);
  return expected.filter((item) => !have.has(item)).sort();
}

function extra(expected: readonly string[], actual: readonly string[]) {
  const want = new Set(expected);
  return actual.filter((item) => !want.has(item)).sort();
}

const REMEDIATION =
  "Ground truth is listBaseModules() in src/modules/index.ts — update the DOC to match the registry, " +
  "never the other way round, and never derive a key from a directory name (src/modules/workflow-approval " +
  "is registered as `workflow`). Do not delete this test to make it pass.";

describe("planning docs <-> module registry reconciliation (Issue #828)", () => {
  describe("doc 01 — Modul utama (base)", () => {
    const heading = "## Modul utama (base)";

    test("lists exactly the registered base modules, as table rows", () => {
      const documented = keysFromTable(DOC_01, heading);

      expect(
        missing(baseModuleKeys, documented),
        `docs/awcms-mini/01_canvas_induk.md ${heading} is missing row(s) for registered module(s). ${REMEDIATION}`
      ).toEqual([]);

      expect(
        extra(baseModuleKeys, documented),
        `docs/awcms-mini/01_canvas_induk.md ${heading} documents module key(s) that are not registered. ${REMEDIATION}`
      ).toEqual([]);
    });

    test("has no duplicate rows", () => {
      const documented = keysFromTable(DOC_01, heading);
      expect(documented.length).toBe(new Set(documented).size);
    });
  });

  describe("doc 13 — Matrix Modul vs Migration", () => {
    const heading = "## Matrix Modul vs Migration";

    test("lists exactly the registered base modules, as table rows", () => {
      const documented = keysFromTable(DOC_13, heading);

      expect(
        missing(baseModuleKeys, documented),
        `docs/awcms-mini/13_final_master_index_traceability.md ${heading} is missing row(s) for registered module(s) — the exact drift Issue #828 found (the table stopped at migration 055 and omitted seven modules). ${REMEDIATION}`
      ).toEqual([]);

      expect(
        extra(baseModuleKeys, documented),
        `docs/awcms-mini/13_final_master_index_traceability.md ${heading} documents module key(s) that are not registered. ${REMEDIATION}`
      ).toEqual([]);
    });

    test("maps exactly the migration files that really exist in sql/", () => {
      const onDisk = readdirSync(path.join(REPO_ROOT, "sql"))
        .filter((file) => file.endsWith(".sql"))
        .sort();

      const rows = tableRowsUnderHeading(DOC_13, heading);
      const cited = rows
        .flatMap(
          (row) => row.join(" ").match(/`(\d{3}_[a-z0-9_]+\.sql)`/g) ?? []
        )
        .map((token) => token.replaceAll("`", ""));

      expect(
        missing(onDisk, cited),
        `Migration file(s) in sql/ that no row of ${heading} maps to a module. Every migration must be attributed — this is what let the table silently stop at 055 while sql/ grew to ${onDisk.length} files. ${REMEDIATION}`
      ).toEqual([]);

      expect(
        extra(onDisk, cited),
        `${heading} cites migration file(s) that do not exist in sql/ — the "fictional filename" defect this table was already once rewritten to remove. ${REMEDIATION}`
      ).toEqual([]);

      const duplicated = cited.filter(
        (file, index) => cited.indexOf(file) !== index
      );
      expect(
        [...new Set(duplicated)].sort(),
        `${heading} maps migration file(s) to more than one module row.`
      ).toEqual([]);
    });
  });

  describe("doc 21 §8 — module classification", () => {
    const heading = "## 8. Peta 26 modul saat ini → kategori";

    test("classifies exactly the registered base modules, as table rows", () => {
      const documented = keysFromTable(DOC_21, heading);

      expect(
        missing(baseModuleKeys, documented),
        `docs/awcms-mini/21_module_admission_governance.md ${heading} is missing row(s) for registered module(s). Its own heading claims to map all 23. ${REMEDIATION}`
      ).toEqual([]);

      expect(
        extra(baseModuleKeys, documented),
        `docs/awcms-mini/21_module_admission_governance.md ${heading} classifies module key(s) that are not registered. ${REMEDIATION}`
      ).toEqual([]);
    });
  });

  test("the count these docs keep quoting matches the registry", () => {
    // The "N modules" number is the single most-copied fact in this repo's
    // docs and has been wrong in at least three of them at once. Assert it
    // HERE, next to the registry, so it fails in CI rather than in the next
    // audit. If this number legitimately changes, the failures above will
    // list every table that still needs a row.
    expect(baseModuleKeys.length).toBe(26);
  });
});
