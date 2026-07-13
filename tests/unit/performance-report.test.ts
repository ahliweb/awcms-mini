/**
 * Unit tests for the performance report builder (Issue #744, epic #738)
 * — specifically `escapeMarkdownTableCell`'s backslash-then-pipe ordering.
 *
 * CodeQL flagged (PR #775) the original call sites for escaping `|` alone
 * without escaping a pre-existing `\` first — a recurring bug class in
 * this repo's docs generators (shipped 3 times before this one, always
 * caught by CodeQL, never by tests/review — see memory note
 * "mdEscape backslash bug recurs"). A value ending in `\|` (e.g. a
 * Windows-style path fragment, or any string with a literal backslash
 * immediately before a pipe) would otherwise turn into `\\|` in the
 * output, which Markdown parses as an escaped backslash (`\\`) followed
 * by an UNESCAPED pipe (`|`) — breaking out of the table cell and
 * corrupting every column after it on that row.
 */
import { describe, expect, test } from "bun:test";

import {
  buildHumanReport,
  escapeMarkdownTableCell,
  type PerformanceReport
} from "../../src/lib/performance/report";

describe("escapeMarkdownTableCell", () => {
  test("escapes a bare pipe", () => {
    expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
  });

  test("escapes a bare backslash", () => {
    expect(escapeMarkdownTableCell("a\\b")).toBe("a\\\\b");
  });

  test("ADVERSARIAL: a literal backslash immediately before a pipe escapes to backslash-then-escaped-pipe, never a bare pipe", () => {
    // Input characters: a \ | b. A pipe-only escaper (the CodeQL-flagged
    // bug) would turn this into `a\\|b` (backslash-escaped-as-itself,
    // pipe left BARE) — a real, unescaped table delimiter. The correct
    // backslash-first order turns it into `a` + `\\` (escaped backslash)
    // + `\|` (escaped pipe) + `b`, i.e. the 6-character sequence
    // a,\,\,\,|,b — no bare pipe anywhere.
    const escaped = escapeMarkdownTableCell("a\\|b");
    expect(escaped).toBe("a\\\\\\|b");
  });

  test("order-independent: backslash-then-pipe and pipe-then-backslash both escape to a well-formed (no bare pipe) result", () => {
    expect(escapeMarkdownTableCell("x\\|y")).toBe("x\\\\\\|y");
    expect(escapeMarkdownTableCell("x|\\y")).toBe("x\\|\\\\y");
  });

  test("leaves a value with neither backslash nor pipe unchanged", () => {
    expect(escapeMarkdownTableCell("plain text")).toBe("plain text");
  });
});

function buildMinimalReport(
  detail: string,
  findingText: string
): PerformanceReport {
  return {
    environment: {
      generatedAt: "2026-07-13T00:00:00.000Z",
      appEnv: "test",
      databaseUrlRedacted: "postgres://<redacted>@localhost:5432/db",
      scaleProfileId: "safe",
      scaleProfileLabel: "safe (CI/PR-safe subset)",
      tenantCount: 5,
      noisyNeighborMultiplier: 6,
      totalSeededRowsPlanned: 100,
      hardware: {
        platform: "linux",
        arch: "x64",
        cpuCount: 4,
        totalMemoryMb: 8192,
        bunVersion: "1.3.14"
      },
      disclaimer: "test disclaimer"
    },
    tier: "safe",
    overall: "fail",
    scenarios: [
      {
        name: "adversarial-scenario",
        tier: "safe",
        status: "fail",
        detail,
        durationMs: 10,
        metrics: {}
      }
    ],
    queryPlanChecks: [
      {
        budgetId: "adversarial-budget",
        ok: false,
        findings: [findingText],
        observedNodeTypes: ["Seq Scan"],
        rootTotalCost: 999,
        executionTimeMs: 42
      }
    ],
    seedSummary: null
  };
}

/**
 * Counts the delimiter `|` characters in a row AFTER removing one known
 * (correctly-escaped) cell value verbatim — the placeholder has no `|`
 * of its own, so the remaining count is exactly the row's real column
 * delimiters. Splitting the raw row on `|` directly would NOT work here:
 * a correctly-escaped pipe inside cell content is still a literal `|`
 * character (just preceded by a backslash), so a naive count would be
 * thrown off by however many escaped pipes the content happens to
 * contain — this helper isolates the STRUCTURAL delimiter count instead.
 */
function countRowDelimitersExcluding(row: string, cellValue: string): number {
  return row.replace(cellValue, "PLACEHOLDER").split("|").length - 1;
}

describe("buildHumanReport — table integrity under adversarial input", () => {
  test("a scenario detail containing a literal backslash-then-pipe is embedded correctly-escaped and does not add a real column delimiter", () => {
    const detail = "regression: a\\|b caused a failure";
    const report = buildMinimalReport(detail, "ok");
    const markdown = buildHumanReport(report);

    const scenarioRow = markdown
      .split("\n")
      .find((line) => line.startsWith("| adversarial-scenario"));

    expect(scenarioRow).toBeDefined();
    // The escaped detail (backslash-first, per escapeMarkdownTableCell)
    // must appear verbatim — proving buildHumanReport actually used the
    // fixed escaper, not a pipe-only one.
    expect(scenarioRow).toContain(escapeMarkdownTableCell(detail));
    // 5 columns (Scenario/Tier/Status/Duration/Detail) => 6 structural
    // `|` delimiters once the escaped detail cell is excluded.
    expect(
      countRowDelimitersExcluding(scenarioRow!, escapeMarkdownTableCell(detail))
    ).toBe(6);
  });

  test("a query-plan finding containing a literal backslash-then-pipe is embedded correctly-escaped and does not add a real column delimiter", () => {
    const finding = "Plan contains forbidden node: a\\|b";
    const report = buildMinimalReport("ok", finding);
    const markdown = buildHumanReport(report);

    const findingRow = markdown
      .split("\n")
      .find((line) => line.startsWith("| adversarial-budget"));

    expect(findingRow).toBeDefined();
    expect(findingRow).toContain(escapeMarkdownTableCell(finding));
    // 5 columns (Budget/Status/Root cost/Execution/Findings) => 6
    // structural `|` delimiters once the escaped findings cell is excluded.
    expect(
      countRowDelimitersExcluding(findingRow!, escapeMarkdownTableCell(finding))
    ).toBe(6);
  });
});
