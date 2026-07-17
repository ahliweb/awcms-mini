/**
 * Query-plan runner (Issue #744, epic #738 platform-evolution) — the I/O
 * half of the query-plan budget gate. Runs `EXPLAIN (FORMAT JSON[, ANALYZE,
 * BUFFERS])` for each registered budget's real SQL text
 * (`query-plan-budgets.ts` holds the THRESHOLDS; this file holds the SQL,
 * kept apart per that file's own header comment) against a REAL,
 * RLS-enforced connection — `app.current_tenant_id` is `SET LOCAL` inside a
 * transaction exactly like `withTenant` (`tenant-context.ts`) does for
 * every real request, so the RLS policy predicate is genuinely part of the
 * plan being evaluated, not bypassed by a privileged connection.
 *
 * Every EXPLAIN — including the two write queries (outbox claim's UPDATE,
 * retention-purge's inner SELECT feeding a DELETE elsewhere) — runs inside
 * a transaction that is ALWAYS rolled back afterward (`explainWithRollback`
 * below), even when `ANALYZE` genuinely executes the statement to get real
 * timing: a query-plan check must never permanently mutate the seeded
 * fixture data other scenarios in the same run depend on.
 */
import { assertUuid } from "../database/tenant-context";
import { deterministicUuid, createPrng } from "./prng";
import {
  findBudget,
  QUERY_PLAN_BUDGETS,
  type ExplainResult,
  type QueryPlanBudget
} from "./query-plan-budgets";

export type QueryPlanQueryDefinition = {
  id: string;
  /** Builds the raw SQL text (positional `$1, $2, ...` placeholders) and its parameter values for one tenant. */
  build: (tenantId: string) => { text: string; values: unknown[] };
  /**
   * Test-only escape hatch, used ONLY by `REGRESSION_FIXTURE_QUERY` below —
   * NEVER set for a real registered budget query. Disables the planner's
   * index/bitmap-scan strategies for this one EXPLAIN (`SET LOCAL
   * enable_indexscan/enable_bitmapscan/enable_indexonlyscan = off`),
   * forcing a genuine Seq Scan. This is necessary, not a shortcut: this
   * schema's RLS policy always injects `tenant_id = current_setting(...)`,
   * and every RLS-protected table here has a `(tenant_id, ...)`-leading
   * index, so even a deliberately unindexed additional predicate (e.g.
   * `message ILIKE ...`) still gets planned as an efficient Index Scan on
   * the tenant_id prefix with the rest applied as a `Filter:` — verified
   * empirically while building this suite (see
   * `tests/integration/performance-query-plan-check.integration.test.ts`'s
   * own comment). Forcing the planner's hand here reproduces exactly the
   * regression this budget exists to catch — "what happens once the
   * relevant index is missing/disabled/defeated" — the same technique a
   * real "did we lose our index" incident would look like in EXPLAIN
   * output, without needing to actually DROP an index on a shared fixture
   * table other checks in the same run still depend on.
   */
  forcePlannerSeqScan?: boolean;
};

const NOW = new Date();
const LEASE_EXPIRY = new Date(NOW.getTime() + 2 * 60_000);
const RETENTION_CUTOFF = new Date(NOW.getTime() - 730 * 24 * 60 * 60 * 1000);

/**
 * SQL text for every entry in `QUERY_PLAN_BUDGETS` — same shape as the real
 * production query the budget's `description` names (see each budget's own
 * `description` field for the exact production call site it mirrors).
 * `tests/unit/performance-query-plan-registry-consistency.test.ts` asserts
 * this id set is identical to `QUERY_PLAN_BUDGETS`'s id set, so the two
 * files can never silently drift apart.
 */
export const QUERY_PLAN_QUERIES: QueryPlanQueryDefinition[] = [
  {
    id: "audit-events-rls-keyset-pagination",
    build: (tenantId) => ({
      text: `
        SELECT id, actor_tenant_user_id, module_key, action, resource_type, resource_id,
               severity, message, attributes, correlation_id, created_at
        FROM awcms_mini_audit_events
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `,
      values: [tenantId]
    })
  },
  {
    id: "abac-decision-logs-rls-pagination",
    build: (tenantId) => ({
      text: `
        SELECT id, module_key, activity_code, action, decision, reason, created_at
        FROM awcms_mini_abac_decision_logs
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `,
      values: [tenantId]
    })
  },
  {
    id: "blog-posts-fulltext-search",
    build: (tenantId) => ({
      text: `
        SELECT id, title, slug
        FROM awcms_mini_blog_posts
        WHERE tenant_id = $1
          AND search_vector @@ websearch_to_tsquery('simple', $2)
        ORDER BY created_at DESC
        LIMIT 20
      `,
      values: [tenantId, "synthetic"]
    })
  },
  {
    id: "object-sync-queue-outbox-claim",
    build: (tenantId) => ({
      text: `
        UPDATE awcms_mini_object_sync_queue
        SET status = 'sending', next_retry_at = $2
        WHERE id IN (
          SELECT id FROM awcms_mini_object_sync_queue
          WHERE tenant_id = $1
            AND status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= $3)
          ORDER BY created_at
          LIMIT $4
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `,
      values: [tenantId, LEASE_EXPIRY, NOW, 25]
    })
  },
  {
    id: "audit-events-retention-purge-batch",
    build: (tenantId) => ({
      text: `
        SELECT id FROM awcms_mini_audit_events
        WHERE tenant_id = $1 AND created_at < $2
        ORDER BY created_at ASC
        LIMIT $3
      `,
      values: [tenantId, RETENTION_CUTOFF, 5000]
    })
  },
  {
    id: "audit-events-tenant-activity-reporting",
    build: (tenantId) => ({
      text: `
        SELECT severity, count(*)::int AS event_count
        FROM awcms_mini_audit_events
        WHERE tenant_id = $1
        GROUP BY severity
      `,
      values: [tenantId]
    })
  },
  {
    // Issue #838. Mirrors `listBlogPostsForAdmin`'s real shape INCLUDING
    // its three optional filters bound to NULL — that is the actual
    // default admin list view (no filter applied), and the
    // `$n IS NULL OR ...` branches are part of the query the planner sees,
    // so dropping them would gate a query this repo never runs.
    id: "blog-posts-admin-list",
    build: (tenantId) => ({
      text: `
        SELECT p.id, p.tenant_id, p.title, p.slug, p.status, p.visibility, p.locale,
               p.author_tenant_user_id, p.published_at, p.updated_at
        FROM awcms_mini_blog_posts p
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
          AND ($2::text IS NULL OR p.status = $2)
          AND ($3::text IS NULL OR p.title ILIKE '%' || $3 || '%')
          AND (
            $4::uuid IS NULL
            OR EXISTS (
              SELECT 1 FROM awcms_mini_blog_post_terms pt
              WHERE pt.tenant_id = p.tenant_id AND pt.post_id = p.id AND pt.term_id = $4
            )
          )
        ORDER BY p.updated_at DESC
        LIMIT 20 OFFSET 0
      `,
      values: [tenantId, null, null, null]
    })
  },
  {
    id: "blog-pages-admin-list",
    build: (tenantId) => ({
      text: `
        SELECT id, tenant_id, title, slug, status, visibility, page_type,
               parent_page_id, menu_order, locale, updated_at
        FROM awcms_mini_blog_pages
        WHERE tenant_id = $1 AND deleted_at IS NULL
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR page_type = $3)
          AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%')
        ORDER BY updated_at DESC
        LIMIT 20 OFFSET 0
      `,
      values: [tenantId, null, null, null]
    })
  }
];

/**
 * A deliberately-broken "regression fixture" query — NOT a real production
 * query, NOT part of `QUERY_PLAN_BUDGETS`. Filters
 * `awcms_mini_audit_events` on `message`, a column with no index at all, so
 * at the `safe` fixture scale (thousands of rows across several tenants)
 * PostgreSQL has no choice but to Seq Scan the whole table. This is the
 * concrete "deliberately introduced regression fixture" the issue's own
 * acceptance criterion asks for, and the adversarial proof
 * (`tests/integration/performance-query-plan-check.integration.test.ts`)
 * that the gate genuinely FAILS a bad plan, not just passes already-good
 * ones — the exact class of gap flagged on this wave's sibling PRs
 * (#769/#740, #770/#743): a checker that looks right in isolation but was
 * never proven to fire on a real regression.
 */
export const REGRESSION_FIXTURE_QUERY: QueryPlanQueryDefinition = {
  id: "regression-fixture-unindexed-message-filter",
  build: (tenantId) => ({
    text: `
      SELECT id FROM awcms_mini_audit_events
      WHERE tenant_id = $1 AND message ILIKE $2
    `,
    values: [tenantId, "%synthetic audit event%"]
  }),
  forcePlannerSeqScan: true
};

/** A budget that ANY plan containing a Seq Scan must fail — paired with `REGRESSION_FIXTURE_QUERY` for the adversarial proof, deliberately NOT registered in `QUERY_PLAN_BUDGETS` (it is a test fixture, not a real gate). */
export const REGRESSION_FIXTURE_BUDGET: QueryPlanBudget = {
  id: REGRESSION_FIXTURE_QUERY.id,
  category: "rls_pagination",
  description:
    "Adversarial regression fixture (Issue #744) — an unindexed predicate that must Seq Scan; proves the query-plan gate genuinely fails a bad plan.",
  forbiddenNodeTypes: ["Seq Scan"],
  requiredNodeTypesAny: [],
  maxTotalCost: 500,
  maxExecutionTimeMs: 50,
  approval: {
    approvedBy: "ahliweb",
    approvedAt: "2026-07-13",
    reason: "Test-only regression fixture, never relaxed."
  }
};

class RollbackSentinel extends Error {
  readonly captured: unknown;

  constructor(captured: unknown) {
    super("query-plan-runner: deliberate rollback after capturing EXPLAIN.");
    this.captured = captured;
  }
}

/**
 * Runs `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) <query>` for one tenant
 * under RLS, inside a transaction that is unconditionally rolled back —
 * see module header for why. Returns the parsed `ExplainResult`.
 *
 * `tenantId` is validated with the same `assertUuid` guard
 * `tenant-context.ts`'s `withTenant` already applies before its own
 * identical `SET LOCAL app.current_tenant_id = '...'` interpolation
 * (security-auditor finding on PR #775) — this function is exported and
 * reusable, so it must not rely on every future caller happening to only
 * ever pass an already-validated fixture-generated UUID.
 */
export async function explainQuery(
  sql: Bun.SQL,
  tenantId: string,
  query: QueryPlanQueryDefinition
): Promise<ExplainResult> {
  const safeTenantId = assertUuid(tenantId);
  const { text, values } = query.build(safeTenantId);

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${safeTenantId}'`);

      if (query.forcePlannerSeqScan) {
        await tx.unsafe("SET LOCAL enable_indexscan = off");
        await tx.unsafe("SET LOCAL enable_bitmapscan = off");
        await tx.unsafe("SET LOCAL enable_indexonlyscan = off");
      }

      const rows = (await tx.unsafe(
        `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${text}`,
        values
      )) as { "QUERY PLAN": ExplainResult[] | string }[];

      // Defensive: PostgreSQL's `EXPLAIN (FORMAT JSON)` returns a `json`
      // (not `jsonb`) column — depending on the driver's type-OID parsing
      // table this may arrive already parsed (array) or as raw text.
      // Handling both keeps this correct regardless of that driver detail.
      const rawPlan = rows[0]?.["QUERY PLAN"];
      const parsedPlan: ExplainResult[] | undefined =
        typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
      const explain = parsedPlan?.[0];

      throw new RollbackSentinel(explain);
    });
  } catch (error) {
    if (error instanceof RollbackSentinel) {
      if (!error.captured) {
        throw new Error(
          `explainQuery: EXPLAIN produced no result for query "${query.id}".`
        );
      }

      return error.captured as ExplainResult;
    }

    throw error;
  }

  // Unreachable: the try block above always either returns via the
  // RollbackSentinel catch, or re-throws a genuine error.
  throw new Error("explainQuery: unreachable.");
}

export type QueryPlanCheckResult = {
  budgetId: string;
  ok: boolean;
  findings: string[];
  observedNodeTypes: string[];
  rootTotalCost: number;
  executionTimeMs: number | null;
};

/**
 * Runs every registered budget's query against one representative tenant
 * (a deterministic, non-noisy-neighbor tenant from the fixture plan — see
 * `scripts/performance-query-plan-check.ts`) and evaluates each against its
 * budget. Import-time circular-safe: only imports the pure evaluator,
 * never anything from `scripts/`.
 */
export async function runAllQueryPlanChecks(
  sql: Bun.SQL,
  tenantId: string
): Promise<QueryPlanCheckResult[]> {
  const { evaluateQueryPlan } = await import("./query-plan-budgets");
  const results: QueryPlanCheckResult[] = [];

  for (const query of QUERY_PLAN_QUERIES) {
    const budget = findBudget(query.id);

    if (!budget) {
      throw new Error(
        `runAllQueryPlanChecks: no budget registered for query id "${query.id}" — ` +
          "query-plan-budgets.ts and query-plan-runner.ts have drifted apart."
      );
    }

    const explain = await explainQuery(sql, tenantId, query);
    const evaluation = evaluateQueryPlan(explain, budget);

    results.push(evaluation);
  }

  return results;
}

/** Deterministic placeholder tenant id generator for standalone CLI usage before a real fixture plan exists (unused once a real plan/tenant is available — kept for symmetry with the rest of this module's determinism discipline). */
export function placeholderTenantId(seed: string): string {
  return deterministicUuid(createPrng(seed));
}

export { QUERY_PLAN_BUDGETS };
