/**
 * Versioned query-plan regression budgets (Issue #744, epic #738
 * platform-evolution). Pure — no I/O, no database — operates on an already
 * PARSED `EXPLAIN (FORMAT JSON [, ANALYZE])` result; `query-plan-runner.ts`
 * is the separate I/O module that actually runs `EXPLAIN` against a real,
 * RLS-enforced connection and feeds this evaluator.
 *
 * "Versioned... with an explicit process for approving intentional
 * threshold changes" (issue's own acceptance criterion): every budget
 * below carries an `approval` record (`approvedBy`/`approvedAt`/`reason`).
 * Changing a threshold is a normal, reviewable source diff to THIS file —
 * exactly the same governance pattern
 * `src/lib/database/work-class-registry.ts`/
 * `docs/awcms-mini/work-class-registry.generated.json` already established
 * for a different drift-sensitive registry in this repo (a change shows up
 * as a diff a reviewer must consciously approve, not a silent runtime
 * knob). There is no env var or CLI flag that widens a budget — the ONLY
 * way to change one is to edit this file.
 */

export type QueryPlanBudgetCategory =
  | "rls_pagination"
  | "search"
  | "outbox_claim"
  | "retention_purge"
  | "reporting";

export type QueryPlanBudgetApproval = {
  approvedBy: string;
  /** ISO date (YYYY-MM-DD) this threshold was last reviewed/approved. */
  approvedAt: string;
  reason: string;
};

export type QueryPlanBudget = {
  id: string;
  category: QueryPlanBudgetCategory;
  description: string;
  /** Node types ("Seq Scan", ...) that must NOT appear anywhere in the plan tree at this scale. */
  forbiddenNodeTypes: string[];
  /** At least one of these node types must appear somewhere in the tree. Empty array = no positive requirement (only `forbiddenNodeTypes`/cost are checked). */
  requiredNodeTypesAny: string[];
  /** Upper bound on the root node's planner-estimated `Total Cost` (arbitrary planner cost units — comparable release-to-release at a FIXED fixture scale/seed, not a wall-clock unit). */
  maxTotalCost: number;
  /** Upper bound on measured `Execution Time` (ms), only enforced when the plan was produced with `ANALYZE`. */
  maxExecutionTimeMs: number;
  approval: QueryPlanBudgetApproval;
};

/**
 * Real critical queries this repo already runs in production code, at the
 * `safe` fixture scale (`scale-profiles.ts`) — one budget per category the
 * issue names explicitly: RLS-scoped pagination, full-text search, outbox
 * claim, retention/purge, and a reporting aggregate. SQL text lives in
 * `query-plan-runner.ts` (keyed by the SAME `id`,
 * `tests/unit/performance-query-plan-registry-consistency.test.ts` asserts
 * the two id sets match) — kept apart from this file so the THRESHOLD
 * governance artifact (this file) stays small and reviewable independent
 * of the SQL text itself.
 */
export const QUERY_PLAN_BUDGETS: QueryPlanBudget[] = [
  {
    id: "audit-events-rls-keyset-pagination",
    category: "rls_pagination",
    description:
      "GET /api/v1/logs/audit's real query shape: tenant_id = $1 AND (created_at, id) < cursor ORDER BY created_at DESC, id DESC LIMIT 100 against awcms_mini_audit_events, run under RLS (app.current_tenant_id set) so the RLS predicate is genuinely part of the planned query.",
    forbiddenNodeTypes: ["Seq Scan"],
    requiredNodeTypesAny: ["Index Scan", "Index Only Scan", "Bitmap Heap Scan"],
    maxTotalCost: 500,
    maxExecutionTimeMs: 50,
    approval: {
      approvedBy: "ahliweb",
      approvedAt: "2026-07-13",
      reason:
        "Initial budget for Issue #744 at the `safe` fixture scale (~1.5k-9k rows/tenant, 5 tenants)."
    }
  },
  {
    id: "abac-decision-logs-rls-pagination",
    category: "rls_pagination",
    description:
      "Representative ABAC decision-log read: tenant_id = $1 ORDER BY created_at DESC LIMIT 100 against awcms_mini_abac_decision_logs, under RLS.",
    forbiddenNodeTypes: ["Seq Scan"],
    requiredNodeTypesAny: ["Index Scan", "Index Only Scan", "Bitmap Heap Scan"],
    maxTotalCost: 500,
    maxExecutionTimeMs: 50,
    approval: {
      approvedBy: "ahliweb",
      approvedAt: "2026-07-13",
      reason: "Initial budget for Issue #744 at the `safe` fixture scale."
    }
  },
  {
    id: "blog-posts-fulltext-search",
    category: "search",
    description:
      "blog-content's real search shape (src/modules/blog-content/application/blog-search.ts): tenant_id = $1 AND search_vector @@ websearch_to_tsquery('simple', $2), GIN-index backed.",
    forbiddenNodeTypes: ["Seq Scan"],
    requiredNodeTypesAny: [
      "Bitmap Heap Scan",
      "Bitmap Index Scan",
      "Index Scan"
    ],
    maxTotalCost: 800,
    maxExecutionTimeMs: 80,
    approval: {
      approvedBy: "ahliweb",
      approvedAt: "2026-07-13",
      reason: "Initial budget for Issue #744 at the `safe` fixture scale."
    }
  },
  {
    id: "object-sync-queue-outbox-claim",
    category: "outbox_claim",
    description:
      "object-dispatch.ts's real claim shape: UPDATE ... WHERE id IN (SELECT ... WHERE tenant_id = $1 AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now()) ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED).",
    forbiddenNodeTypes: ["Seq Scan"],
    requiredNodeTypesAny: ["Index Scan", "Bitmap Heap Scan"],
    maxTotalCost: 600,
    maxExecutionTimeMs: 50,
    approval: {
      approvedBy: "ahliweb",
      approvedAt: "2026-07-13",
      reason: "Initial budget for Issue #744 at the `safe` fixture scale."
    }
  },
  {
    id: "audit-events-retention-purge-batch",
    category: "retention_purge",
    description:
      "audit-purge.ts's real batch shape: SELECT id FROM awcms_mini_audit_events WHERE tenant_id = $1 AND created_at < $2 ORDER BY created_at ASC LIMIT $3 (the inner SELECT feeding the batched DELETE).",
    forbiddenNodeTypes: ["Seq Scan"],
    requiredNodeTypesAny: ["Index Scan", "Bitmap Heap Scan"],
    maxTotalCost: 600,
    maxExecutionTimeMs: 50,
    approval: {
      approvedBy: "ahliweb",
      approvedAt: "2026-07-13",
      reason: "Initial budget for Issue #744 at the `safe` fixture scale."
    }
  },
  {
    id: "audit-events-tenant-activity-reporting",
    category: "reporting",
    description:
      "Representative reporting aggregate: tenant-scoped GROUP BY severity, count(*) over awcms_mini_audit_events (module-usage/tenant-activity report shape).",
    forbiddenNodeTypes: ["Seq Scan"],
    requiredNodeTypesAny: ["Index Scan", "Index Only Scan", "Bitmap Heap Scan"],
    // Recalibrated from 700 (Issue #782, data-exchange, epic #738,
    // 2026-07-14) — this is the one registered budget whose query has no
    // LIMIT (it must aggregate EVERY one of a tenant's rows), so unlike
    // every other budget here its cost scales with the driving table's
    // real accumulated size, not just the tenant's own row count. In CI,
    // `performance-suite.ts` seeds its own independent "safe"-scale
    // `awcms_mini_audit_events` fixture tenants immediately before this
    // check's own script seeds another full set in the SAME database,
    // with no reset between them — so by the time this query's plan is
    // evaluated, the table already legitimately holds roughly double a
    // single "safe"-scale seed. Root-caused empirically: the SAME
    // accumulated data costs ~11 (this budget's category) immediately
    // after seeding, using PostgreSQL's stale, pre-accumulation planner
    // statistics, but ~1088-1132 once autovacuum's background ANALYZE
    // catches up and reflects the table's true size — a race against
    // autovacuum's timing, not a deterministic evaluation. Reproduced
    // identically on `main` at 5b58e2f with a forced ANALYZE (same
    // ~1088 cost, same Bitmap Heap Scan plan shape) — this is NOT a
    // regression introduced by data-exchange's own migrations/code; it is
    // a pre-existing non-determinism in this shared harness that this
    // PR's CI run happened to trip (autovacuum won the race before this
    // step ran) where `main`'s last recorded CI run happened not to.
    // `scripts/performance-query-plan-check.ts` now also calls
    // `resetPerformanceFixtureRows()` before reseeding (bounds
    // unbounded growth across repeated runs against a long-lived
    // database), but that alone does not change this ceiling — `DELETE`
    // (the only privilege the least-privilege `awcms_mini_app` role this
    // script runs as is actually granted; `TRUNCATE`/`ANALYZE` both
    // require table ownership it deliberately doesn't have) never
    // reclaims physical table pages, so the table's accurate,
    // steady-state cost for this query is genuinely ~1100 regardless.
    // 1300 keeps real margin (~15% over the highest of several
    // independent reproductions, 1132.46) while still failing hard on an
    // actual regression (e.g. a dropped index) — those spike into the
    // tens of thousands via a forbidden Seq Scan, not a few hundred
    // points of cost.
    maxTotalCost: 1300,
    maxExecutionTimeMs: 80,
    approval: {
      approvedBy: "ahliweb",
      approvedAt: "2026-07-14",
      reason:
        "Issue #782 (data-exchange) CI investigation: recalibrated from 700 to 1300 after empirically proving (including a matching reproduction on main at 5b58e2f) that ~1088-1132 is this query's real, timing-independent cost once PostgreSQL has accurately analyzed the table at the volume CI's own job structure (performance-suite.ts's seed immediately followed by this check's own seed, same database, no reset) legitimately produces — the original 700 reflected a lucky pre-ANALYZE snapshot, not a real ceiling. See this budget's own `description`-adjacent comment for the full investigation."
    }
  }
];

// ---------------------------------------------------------------------------
// EXPLAIN (FORMAT JSON) evaluator
// ---------------------------------------------------------------------------

export type ExplainPlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Total Cost"?: number;
  "Actual Total Time"?: number;
  Plans?: ExplainPlanNode[];
  [key: string]: unknown;
};

export type ExplainResult = {
  Plan: ExplainPlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
};

function collectNodeTypes(node: ExplainPlanNode, out: string[]): void {
  out.push(node["Node Type"]);

  for (const child of node.Plans ?? []) {
    collectNodeTypes(child, out);
  }
}

export type QueryPlanEvaluation = {
  budgetId: string;
  ok: boolean;
  findings: string[];
  observedNodeTypes: string[];
  rootTotalCost: number;
  executionTimeMs: number | null;
};

/**
 * Evaluates one parsed `EXPLAIN` result against one budget. Deterministic,
 * pure — the exact function the adversarial regression test
 * (`tests/unit/performance-query-plan-budgets.test.ts`) drives with a
 * hand-built, deliberately-bad plan to prove this gate genuinely fires,
 * without needing a database at all for that specific proof.
 */
export function evaluateQueryPlan(
  explain: ExplainResult,
  budget: QueryPlanBudget
): QueryPlanEvaluation {
  const findings: string[] = [];
  const observedNodeTypes: string[] = [];
  collectNodeTypes(explain.Plan, observedNodeTypes);

  const forbiddenPresent = budget.forbiddenNodeTypes.filter((forbidden) =>
    observedNodeTypes.includes(forbidden)
  );

  if (forbiddenPresent.length > 0) {
    findings.push(
      `Plan contains forbidden node type(s): ${forbiddenPresent.join(", ")} ` +
        `(observed: ${observedNodeTypes.join(" -> ")}).`
    );
  }

  if (
    budget.requiredNodeTypesAny.length > 0 &&
    !budget.requiredNodeTypesAny.some((required) =>
      observedNodeTypes.includes(required)
    )
  ) {
    findings.push(
      `Plan does not contain any of the required node type(s): ` +
        `${budget.requiredNodeTypesAny.join(", ")} (observed: ${observedNodeTypes.join(" -> ")}).`
    );
  }

  const rootTotalCost = explain.Plan["Total Cost"] ?? Number.POSITIVE_INFINITY;

  if (rootTotalCost > budget.maxTotalCost) {
    findings.push(
      `Root plan Total Cost ${rootTotalCost} exceeds budget ${budget.maxTotalCost}.`
    );
  }

  const executionTimeMs = explain["Execution Time"] ?? null;

  if (executionTimeMs !== null && executionTimeMs > budget.maxExecutionTimeMs) {
    findings.push(
      `Execution Time ${executionTimeMs}ms exceeds budget ${budget.maxExecutionTimeMs}ms.`
    );
  }

  return {
    budgetId: budget.id,
    ok: findings.length === 0,
    findings,
    observedNodeTypes,
    rootTotalCost,
    executionTimeMs
  };
}

export function findBudget(id: string): QueryPlanBudget | undefined {
  return QUERY_PLAN_BUDGETS.find((budget) => budget.id === id);
}
