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
  findBudget,
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

/**
 * Issue #838 — the blog admin-list budgets, driven by the plans a REAL
 * PostgreSQL actually produced at the `safe` fixture scale with the Issue
 * #830 index present vs genuinely `DROP INDEX`ed (the drop was asserted
 * against `pg_indexes` before the second plan was captured, so these are
 * not hypothetical shapes). The integration test
 * `performance-query-plan-check.integration.test.ts` re-proves the same
 * thing end-to-end against a live database; this suite pins the REASONING
 * down as a pure, always-runs-in-CI unit test so the budgets can never be
 * "simplified" back into a gate that does not fire.
 */
const REAL_INDEX_PRESENT_PLAN: ExplainResult = {
  Plan: {
    "Node Type": "Limit",
    "Total Cost": 62.06,
    Plans: [
      {
        "Node Type": "Index Scan",
        "Relation Name": "awcms_mini_blog_posts",
        "Index Name": "awcms_mini_blog_posts_tenant_updated_idx",
        "Total Cost": 62.06
      }
    ]
  },
  "Execution Time": 0.055
};

/**
 * The measured regression: with `awcms_mini_blog_posts_tenant_updated_idx`
 * dropped, PostgreSQL does NOT fall back to a Seq Scan — it uses the
 * still-present `awcms_mini_blog_posts_tenant_deleted_idx` and bolts a
 * `Sort` on top. THIS is why the budget forbids `Sort`.
 */
const REAL_INDEX_DROPPED_PLAN: ExplainResult = {
  Plan: {
    "Node Type": "Limit",
    "Total Cost": 939.88,
    Plans: [
      {
        "Node Type": "Sort",
        "Total Cost": 939.88,
        Plans: [
          {
            "Node Type": "Bitmap Heap Scan",
            "Relation Name": "awcms_mini_blog_posts",
            "Total Cost": 931.53,
            Plans: [
              {
                "Node Type": "Bitmap Index Scan",
                "Index Name": "awcms_mini_blog_posts_tenant_deleted_idx",
                "Total Cost": 6.36
              }
            ]
          }
        ]
      }
    ]
  },
  "Execution Time": 0.35
};

describe("Issue #838 — blog admin-list budgets vs the REAL measured index-drop regression", () => {
  for (const budgetId of ["blog-posts-admin-list", "blog-pages-admin-list"]) {
    test(`${budgetId} PASSES the real index-present plan (the gate is not simply always-red)`, () => {
      const budget = findBudget(budgetId)!;
      const evaluation = evaluateQueryPlan(REAL_INDEX_PRESENT_PLAN, budget);

      expect([budgetId, evaluation.ok, evaluation.findings]).toEqual([
        budgetId,
        true,
        []
      ]);
    });

    test(`${budgetId} FAILS the real index-dropped plan (the gate genuinely fires)`, () => {
      const budget = findBudget(budgetId)!;
      const evaluation = evaluateQueryPlan(REAL_INDEX_DROPPED_PLAN, budget);

      expect(evaluation.ok).toBe(false);
      // Both independent lines of defence must fire on this plan, so the
      // budget still catches the regression if either one is ever relaxed.
      expect(evaluation.findings.some((f) => f.includes("Sort"))).toBe(true);
      expect(evaluation.findings.some((f) => f.includes("Total Cost"))).toBe(
        true
      );
    });
  }

  /**
   * The vacuity proof, and the whole reason these two budgets do not simply
   * copy the five that came before them. Copying the obvious
   * `forbiddenNodeTypes: ["Seq Scan"]` shape would have produced a budget
   * that PASSES the very regression it was filed to catch.
   */
  test("a naive Seq-Scan-only budget would NOT have caught this regression — proving why `Sort` is forbidden", () => {
    const naiveBudget: QueryPlanBudget = {
      ...findBudget("blog-posts-admin-list")!,
      forbiddenNodeTypes: ["Seq Scan"],
      requiredNodeTypesAny: [
        "Index Scan",
        "Index Only Scan",
        "Bitmap Heap Scan"
      ],
      maxTotalCost: 5_000
    };

    const naiveEvaluation = evaluateQueryPlan(
      REAL_INDEX_DROPPED_PLAN,
      naiveBudget
    );
    const realEvaluation = evaluateQueryPlan(
      REAL_INDEX_DROPPED_PLAN,
      findBudget("blog-posts-admin-list")!
    );

    // The naive budget sees no Seq Scan and a satisfied "Bitmap Heap Scan"
    // requirement, so it passes a plan that costs 15x the indexed one...
    expect(naiveEvaluation.ok).toBe(true);
    expect(naiveEvaluation.observedNodeTypes).not.toContain("Seq Scan");
    // ...while the budget actually registered fails it.
    expect(realEvaluation.ok).toBe(false);
  });

  test("the registered admin-list budgets require an Index Scan specifically — a Bitmap Heap Scan is not an acceptable substitute for index-ordered access", () => {
    for (const budgetId of ["blog-posts-admin-list", "blog-pages-admin-list"]) {
      const budget = findBudget(budgetId)!;

      expect(budget.requiredNodeTypesAny).toEqual(["Index Scan"]);
      expect(budget.forbiddenNodeTypes).toContain("Sort");
      expect(budget.forbiddenNodeTypes).toContain("Incremental Sort");
    }
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

  test("covers every category the issues name (Issue #744: RLS/pagination, search, outbox claim, retention/purge, reporting; Issue #838: admin list)", () => {
    const categories = new Set(QUERY_PLAN_BUDGETS.map((b) => b.category));
    expect(categories).toEqual(
      new Set([
        "rls_pagination",
        "search",
        "outbox_claim",
        "retention_purge",
        "reporting",
        "admin_list"
      ])
    );
  });

  /**
   * Issue #838: the admin-list budgets deliberately forbid `Sort` as their
   * PRIMARY signal (see their own comment in `query-plan-budgets.ts` — the
   * measured index-drop regression produces a Bitmap Heap Scan + Sort, not
   * a Seq Scan). They still forbid `Seq Scan` too, so the invariant above
   * holds registry-wide; this asserts the ordering guarantee is never
   * quietly dropped from an `admin_list` budget while leaving it looking
   * plausible.
   */
  test("every admin_list budget forbids sorting — its whole point is that an index serves the ORDER BY", () => {
    const adminListBudgets = QUERY_PLAN_BUDGETS.filter(
      (budget) => budget.category === "admin_list"
    );

    expect(adminListBudgets.length).toBeGreaterThan(0);

    for (const budget of adminListBudgets) {
      expect([budget.id, budget.forbiddenNodeTypes.includes("Sort")]).toEqual([
        budget.id,
        true
      ]);
      expect([
        budget.id,
        budget.forbiddenNodeTypes.includes("Incremental Sort")
      ]).toEqual([budget.id, true]);
    }
  });
});
