/**
 * Guards against `query-plan-budgets.ts` (thresholds) and
 * `query-plan-runner.ts` (SQL text) drifting apart (Issue #744, epic
 * #738) — each budget MUST have exactly one matching query definition, and
 * vice versa, or `runAllQueryPlanChecks` would silently skip a budget or
 * throw at runtime. Pure — no database.
 */
import { describe, expect, test } from "bun:test";

import { QUERY_PLAN_BUDGETS } from "../../src/lib/performance/query-plan-budgets";
import { QUERY_PLAN_ANALYZE_TABLES } from "../../src/lib/performance/analyze-fixtures";
import {
  QUERY_PLAN_QUERIES,
  REGRESSION_FIXTURE_BUDGET,
  REGRESSION_FIXTURE_QUERY
} from "../../src/lib/performance/query-plan-runner";

const PLACEHOLDER_TENANT = "00000000-0000-0000-0000-000000000000";

describe("query-plan budgets <-> queries id parity", () => {
  test("every budget id has a matching query definition", () => {
    const queryIds = new Set(QUERY_PLAN_QUERIES.map((q) => q.id));

    for (const budget of QUERY_PLAN_BUDGETS) {
      expect(queryIds.has(budget.id)).toBe(true);
    }
  });

  test("every query definition has a matching budget", () => {
    const budgetIds = new Set(QUERY_PLAN_BUDGETS.map((b) => b.id));

    for (const query of QUERY_PLAN_QUERIES) {
      expect(budgetIds.has(query.id)).toBe(true);
    }
  });

  test("the id sets are identical (no drift either direction)", () => {
    const budgetIds = QUERY_PLAN_BUDGETS.map((b) => b.id).sort();
    const queryIds = QUERY_PLAN_QUERIES.map((q) => q.id).sort();

    expect(queryIds).toEqual(budgetIds);
  });

  test("the regression fixture query/budget pair is deliberately NOT part of the real registry", () => {
    const budgetIds = new Set(QUERY_PLAN_BUDGETS.map((b) => b.id));
    const queryIds = new Set(QUERY_PLAN_QUERIES.map((q) => q.id));

    expect(budgetIds.has(REGRESSION_FIXTURE_QUERY.id)).toBe(false);
    expect(queryIds.has(REGRESSION_FIXTURE_QUERY.id)).toBe(false);
    expect(REGRESSION_FIXTURE_BUDGET.id).toBe(REGRESSION_FIXTURE_QUERY.id);
  });
});

describe("query-plan ANALYZE table coverage (Issue #849)", () => {
  // A budget whose driving table is NOT in QUERY_PLAN_ANALYZE_TABLES would be
  // evaluated against stale/absent planner statistics — exactly the
  // non-deterministic flake Issue #849 exists to close. This pure-unit gate
  // turns "someone added a budget over a not-yet-ANALYZEd table" into a red
  // test here, instead of a mysterious CI flake later.
  test("every registered query references at least one ANALYZEd driving table", () => {
    for (const query of QUERY_PLAN_QUERIES) {
      const { text } = query.build(PLACEHOLDER_TENANT);
      const covered = QUERY_PLAN_ANALYZE_TABLES.some((table) =>
        text.includes(table)
      );
      expect([query.id, covered]).toEqual([query.id, true]);
    }
  });

  test("no ANALYZEd table is orphaned — each is the driving table of some registered query", () => {
    const allQueryText = QUERY_PLAN_QUERIES.map(
      (query) => query.build(PLACEHOLDER_TENANT).text
    ).join("\n");

    for (const table of QUERY_PLAN_ANALYZE_TABLES) {
      expect([table, allQueryText.includes(table)]).toEqual([table, true]);
    }
  });
});
