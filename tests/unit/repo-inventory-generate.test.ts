/**
 * Issue #688 (epic #679 platform-hardening): `scripts/repo-inventory-generate.ts`
 * generates `docs/awcms-mini/repo-inventory.md` from the module registry,
 * `sql/*.sql` migrations, `tests/`, and the bundled OpenAPI contract. Mirrors
 * the determinism/freshness properties `tests/unit/api-docs-generate.test.ts`
 * asserts for the API reference doc.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  REPO_INVENTORY_PATH,
  RLS_EXEMPT_TABLES,
  buildRepoInventoryMarkdown,
  extractRlsEnabledTables,
  mdEscape
} from "../../scripts/repo-inventory-generate";
import { runRepoInventoryCheck } from "../../scripts/repo-inventory-check";
import { listModules } from "../../src/modules";

describe("buildRepoInventoryMarkdown determinism", () => {
  test("generating twice against the real repo state is byte-identical", async () => {
    const first = await buildRepoInventoryMarkdown();
    const second = await buildRepoInventoryMarkdown();
    expect(second).toBe(first);
  });

  test("the committed inventory doc matches what the generator produces right now (freshness)", async () => {
    const fresh = await buildRepoInventoryMarkdown();
    const committed = await readFile(
      path.join(process.cwd(), REPO_INVENTORY_PATH),
      "utf8"
    );
    expect(fresh).toBe(committed);
  });

  test("runRepoInventoryCheck reports no problems against the committed doc", async () => {
    const problems = await runRepoInventoryCheck();
    expect(problems).toEqual([]);
  });
});

describe("buildRepoInventoryMarkdown content coverage", () => {
  test("every registered module key appears in the Modules table", async () => {
    const markdown = await buildRepoInventoryMarkdown();
    const modules = listModules();
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      expect(markdown.includes(`\`${module.key}\``)).toBe(true);
    }
  });

  test("no tenant-scoped table is reported as a possible RLS gap", async () => {
    const markdown = await buildRepoInventoryMarkdown();
    // The generator only emits this heading when it found tenant-scoped
    // tables with no ENABLE ROW LEVEL SECURITY statement and no reviewed
    // exemption — this is a regression guard that the repo's real RLS
    // enforcement (ADR-0003, migration 013) stays consistent with the
    // static inventory heuristic.
    expect(markdown).not.toContain("POSSIBLE GAP");
  });

  test("every RLS-exempt allow-list entry is present in the generated doc", async () => {
    const markdown = await buildRepoInventoryMarkdown();
    for (const table of Object.keys(RLS_EXEMPT_TABLES)) {
      expect(markdown.includes(`\`${table}\``)).toBe(true);
    }
  });

  test("is marked GENERATED and documents the regeneration command", async () => {
    const markdown = await buildRepoInventoryMarkdown();
    expect(markdown).toContain("GENERATED FILE");
    expect(markdown).toContain("bun run repo:inventory:generate");
  });
});

describe("extractRlsEnabledTables", () => {
  test("a commented-out ALTER TABLE ... ENABLE ROW LEVEL SECURITY is not counted as enabled (reviewer finding, PR #722)", () => {
    const sql = [
      "CREATE TABLE example (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);",
      "-- ALTER TABLE example ENABLE ROW LEVEL SECURITY;"
    ].join("\n");
    expect(extractRlsEnabledTables(sql).has("example")).toBe(false);
  });

  test("a live (uncommented) statement is still counted as enabled", () => {
    const sql = [
      "CREATE TABLE example (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);",
      "ALTER TABLE example ENABLE ROW LEVEL SECURITY;"
    ].join("\n");
    expect(extractRlsEnabledTables(sql).has("example")).toBe(true);
  });
});

describe("mdEscape", () => {
  test("a literal backslash immediately before a pipe does not leave the pipe unescaped (CodeQL js/incomplete-sanitization, PR #722)", () => {
    // Escaping only `|` (the pre-fix version) would turn `a\|b` into
    // `a\\|b` — an even number of backslashes in front of the pipe means
    // the pipe is still a live, unescaped table-cell delimiter under GFM's
    // backslash-escaping rules. Escaping backslashes first closes this.
    const escaped = mdEscape("a\\|b");
    const backslashesBeforePipeIndex = escaped.indexOf("|");
    let runLength = 0;
    for (let i = backslashesBeforePipeIndex - 1; escaped[i] === "\\"; i--) {
      runLength++;
    }
    expect(runLength % 2).toBe(1);
  });
});

describe("runRepoInventoryCheck", () => {
  test("reports a missing-file problem when the doc does not exist", async () => {
    const problems = await runRepoInventoryCheck("/nonexistent-root-dir");
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("repo:inventory:generate");
  });
});
