/**
 * Unit tests for the query-plan regression evaluator (Issue #744, epic
 * #738). Pure — operates on hand-built `EXPLAIN (FORMAT JSON)` shapes, no
 * database. This is the FIRST of two adversarial proofs this issue ships
 * (the second, against a REAL Postgres plan, is
 * `tests/integration/performance-query-plan-check.integration.test.ts`) —
 * both exist because a checker that only ever gets called with
 * already-good input (the wave's own recurring gap on #769/#740 and
 * #770/#743) proves nothing about whether it can actually catch a
 * regression.
 */
import { describe, expect, test } from "bun:test";

import {
  evaluateQueryPlan,
  QUERY_PLAN_BUDGETS,
  type ExplainResult,
  type QueryPlanBudget
} from "../../src/lib/performance/query-plan-budgets";

const GOOD_BUDGET: QueryPlanBudget = {
  id: "test-good-budget",
  category: "rls_pagination",
  description: "test fixture",
  forbiddenNodeTypes: ["Seq Scan"],
  requiredNodeTypesAny: ["Index Scan", "Index Only Scan", "Bitmap Heap Scan"],
  maxTotalCost: 500,
  maxExecutionTimeMs: 50,
  approval: {
    approvedBy: "test",
    approvedAt: "2026-07-13",
    reason: "test fixture"
  }
};

function indexScanPlan(
  totalCost: number,
  executionTimeMs?: number
): ExplainResult {
  return {
    Plan: {
      "Node Type": "Limit",
      "Total Cost": totalCost,
      Plans: [
        {
          "Node Type": "Index Scan",
          "Relation Name": "awcms_mini_audit_events",
          "Total Cost": totalCost
        }
      ]
    },
    ...(executionTimeMs !== undefined
      ? { "Execution Time": executionTimeMs }
      : {})
  };
}

function seqScanPlan(
  totalCost: number,
  executionTimeMs?: number
): ExplainResult {
  return {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "awcms_mini_audit_events",
      "Total Cost": totalCost
    },
    ...(executionTimeMs !== undefined
      ? { "Execution Time": executionTimeMs }
      : {})
  };
}

describe("evaluateQueryPlan — well-behaved (already-good) plans", () => {
  test("passes an index-backed plan within budget", () => {
    const evaluation = evaluateQueryPlan(indexScanPlan(120, 5), GOOD_BUDGET);

    expect(evaluation.ok).toBe(true);
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.observedNodeTypes).toEqual(["Limit", "Index Scan"]);
  });

  test("plans with no Execution Time (plan-only, no ANALYZE) skip the time check", () => {
    const evaluation = evaluateQueryPlan(indexScanPlan(120), GOOD_BUDGET);
    expect(evaluation.ok).toBe(true);
    expect(evaluation.executionTimeMs).toBeNull();
  });
});

describe("evaluateQueryPlan — adversarial proof: the gate genuinely fires on a bad plan", () => {
  test("FAILS a plan containing a forbidden Seq Scan node", () => {
    const evaluation = evaluateQueryPlan(seqScanPlan(50_000, 400), GOOD_BUDGET);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.findings.some((f) => f.includes("Seq Scan"))).toBe(true);
  });

  test("FAILS a plan missing every required node type, even with acceptable cost", () => {
    const planWithOnlyASort: ExplainResult = {
      Plan: { "Node Type": "Sort", "Total Cost": 10 }
    };

    const evaluation = evaluateQueryPlan(planWithOnlyASort, GOOD_BUDGET);

    expect(evaluation.ok).toBe(false);
    expect(
      evaluation.findings.some((f) => f.includes("required node type"))
    ).toBe(true);
  });

  test("FAILS a plan whose Total Cost exceeds the budget, even without any forbidden node", () => {
    const evaluation = evaluateQueryPlan(
      indexScanPlan(999_999, 5),
      GOOD_BUDGET
    );

    expect(evaluation.ok).toBe(false);
    expect(evaluation.findings.some((f) => f.includes("Total Cost"))).toBe(
      true
    );
  });

  test("FAILS a plan whose measured Execution Time exceeds the budget", () => {
    const evaluation = evaluateQueryPlan(indexScanPlan(50, 5_000), GOOD_BUDGET);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.findings.some((f) => f.includes("Execution Time"))).toBe(
      true
    );
  });

  test("collects EVERY violation, not just the first", () => {
    const evaluation = evaluateQueryPlan(
      seqScanPlan(999_999, 9_999),
      GOOD_BUDGET
    );

    expect(evaluation.ok).toBe(false);
    expect(evaluation.findings.length).toBeGreaterThanOrEqual(3);
  });

  test("walks nested child plans to find a Seq Scan buried under a Nested Loop", () => {
    const nested: ExplainResult = {
      Plan: {
        "Node Type": "Nested Loop",
        "Total Cost": 10,
        Plans: [
          { "Node Type": "Index Scan", "Total Cost": 5 },
          { "Node Type": "Seq Scan", "Total Cost": 5 }
        ]
      }
    };

    const evaluation = evaluateQueryPlan(nested, GOOD_BUDGET);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.observedNodeTypes).toContain("Seq Scan");
  });
});

describe("QUERY_PLAN_BUDGETS registry", () => {
  test("every budget has a unique id", () => {
    const ids = QUERY_PLAN_BUDGETS.map((budget) => budget.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every budget carries a non-empty approval record (versioned governance)", () => {
    for (const budget of QUERY_PLAN_BUDGETS) {
      expect(budget.approval.approvedBy.length).toBeGreaterThan(0);
      expect(budget.approval.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(budget.approval.reason.length).toBeGreaterThan(0);
    }
  });

  test("every budget forbids Seq Scan at the fixture scale it was approved for", () => {
    for (const budget of QUERY_PLAN_BUDGETS) {
      expect(budget.forbiddenNodeTypes).toContain("Seq Scan");
    }
  });

  test("covers every category the issue names (RLS/pagination, search, outbox claim, retention/purge, reporting)", () => {
    const categories = new Set(QUERY_PLAN_BUDGETS.map((b) => b.category));
    expect(categories).toEqual(
      new Set([
        "rls_pagination",
        "search",
        "outbox_claim",
        "retention_purge",
        "reporting"
      ])
    );
  });
});
