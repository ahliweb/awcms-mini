/**
 * `docs/awcms-mini/observability-metrics.md` §"Cardinality and privacy review"
 * calls itself an ACCEPTANCE CRITERION: every metric this codebase emits is
 * supposed to be listed there with its label set and cardinality bound, so
 * that adding a metric forces a deliberate privacy/cardinality decision.
 *
 * It was never checked. By the time this test was written the table listed 19
 * of 48 declared metrics — five whole families (domain events, business scope,
 * SoD, workflow, profile identity, organization structure, control plane) had
 * accumulated with no entry at all. A hand-maintained table that nothing
 * verifies is a guarantee on paper only, which is worse than no guarantee,
 * because reviewers cite it.
 *
 * This gate is deliberately narrow: it asserts COVERAGE (every declared metric
 * has a row, and no row names a metric that no longer exists), not prose
 * quality. The cardinality/privacy reasoning stays human-written — the point
 * is that a new metric cannot silently skip having that reasoning written down.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { METRIC_DEFINITIONS } from "../../src/lib/observability/metrics-port";

const DOC_PATH = resolve(
  import.meta.dir,
  "../../docs/awcms-mini/observability-metrics.md"
);

/** Metric names that appear as the first cell of a markdown table row. */
function metricNamesInDoc(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(line.trim());
    if (match) names.add(match[1]!);
  }
  return names;
}

describe("observability metrics doc coverage", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const documented = metricNamesInDoc(markdown);
  const declared = Object.keys(METRIC_DEFINITIONS);

  test("every declared metric has a row in the cardinality/privacy table", () => {
    const missing = declared.filter((name) => !documented.has(name));
    expect(
      missing.length === 0
        ? "none missing"
        : `missing from docs/awcms-mini/observability-metrics.md: ${missing.join(", ")}`
    ).toBe("none missing");
  });

  test("no documented row names a metric that no longer exists", () => {
    // Catches the opposite drift: a metric renamed or removed in code while
    // its row lingers, which would have a reviewer looking for a series that
    // is never emitted.
    const declaredSet = new Set<string>(declared);
    const stale = [...documented].filter((name) => !declaredSet.has(name));
    expect(
      stale.length === 0
        ? "none stale"
        : `documented but not declared in METRIC_DEFINITIONS: ${stale.join(", ")}`
    ).toBe("none stale");
  });

  test("the table is not trivially empty", () => {
    // Guards the whole file: a doc rewrite that dropped the table would
    // otherwise make both assertions above pass vacuously only if declared
    // were also empty — this pins the real expectation.
    expect(declared.length).toBeGreaterThan(20);
    expect(documented.size).toBeGreaterThanOrEqual(declared.length);
  });
});
