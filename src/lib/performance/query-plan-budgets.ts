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
    maxTotalCost: 700,
    maxExecutionTimeMs: 80,
    approval: {
      approvedBy: "ahliweb",
      approvedAt: "2026-07-13",
      reason: "Initial budget for Issue #744 at the `safe` fixture scale."
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
