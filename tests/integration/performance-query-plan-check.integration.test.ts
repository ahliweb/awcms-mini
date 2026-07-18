/**
 * Integration tests for the query-plan regression gate (Issue #744, epic
 * #738) against a REAL PostgreSQL, seeded with the `safe` scale synthetic
 * fixtures. This is the SECOND, strongest adversarial proof this issue
 * ships (the first, pure-function proof against hand-built EXPLAIN JSON,
 * is `tests/unit/performance-query-plan-budgets.test.ts`): a deliberately
 * unindexed query is run against a REAL Postgres planner and asserted to
 * genuinely produce a Seq Scan that the gate then fails — exactly the
 * "prove the gate fires on a bad plan, don't just assert it on already-
 * good input" proof this wave's own sibling PRs (#769/#740, #770/#743)
 * were each found missing.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import {
  evaluateQueryPlan,
  QUERY_PLAN_BUDGETS
} from "../../src/lib/performance/query-plan-budgets";
import {
  analyzeQueryPlanFixtures,
  QUERY_PLAN_ANALYZE_TABLES,
  type QueryPlanAnalyzeResult
} from "../../src/lib/performance/analyze-fixtures";
import { buildFixturePlan } from "../../src/lib/performance/fixture-generator";
import { seedPerformanceFixtures } from "../../src/lib/performance/fixture-seeder";
import {
  explainQuery,
  QUERY_PLAN_QUERIES,
  REGRESSION_FIXTURE_BUDGET,
  REGRESSION_FIXTURE_QUERY,
  runAllQueryPlanChecks
} from "../../src/lib/performance/query-plan-runner";
import { SAFE_SCALE_PROFILE } from "../../src/lib/performance/scale-profiles";

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "performance query-plan budgets (Issue #744) — real Postgres, adversarial proof",
  () => {
    let tenantId: string;
    let analyzeResults: QueryPlanAnalyzeResult[];

    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
      await resetDatabase();

      const plan = buildFixturePlan(SAFE_SCALE_PROFILE, "query-plan-check-it");
      await seedPerformanceFixtures(getTestSql(), plan);
      tenantId = plan.tenants[0]!.tenantId;

      // Fresh, ACCURATE planner statistics. Issue #849: an `ANALYZE` issued
      // on `getTestSql()` (the least-privilege `awcms_mini_app` role) is
      // SILENTLY SKIPPED — the role does not own these tables, so PostgreSQL
      // emits a WARNING and returns success WITHOUT refreshing anything. The
      // budgets below would then pass or fail by accident of autovacuum
      // timing rather than a real measurement. Running `ANALYZE` via the
      // PRIVILEGED (owner) `getAdminSql()` connection — and PROVING it
      // advanced `pg_stat_user_tables.analyze_count` for every table
      // (`analyzeQueryPlanFixtures` throws otherwise) — is what makes this
      // suite deterministic. Reverting to `getTestSql()` here makes this
      // `beforeAll` throw, which is the red half of the Issue #849 fix.
      analyzeResults = await analyzeQueryPlanFixtures(
        getAdminSql(),
        QUERY_PLAN_ANALYZE_TABLES
      );
    });

    test("Issue #849: the beforeAll ANALYZE genuinely refreshed planner statistics (not a silent no-op)", () => {
      expect(analyzeResults.length).toBe(QUERY_PLAN_ANALYZE_TABLES.length);

      // analyze_count strictly advanced for EVERY driving table — the honest,
      // resolution-independent proof that ANALYZE actually ran, rather than
      // trusting the exit code of a command PostgreSQL skips silently.
      for (const result of analyzeResults) {
        expect([
          result.table,
          result.analyzeCountAfter > result.analyzeCountBefore
        ]).toEqual([result.table, true]);
      }
    });

    test("every registered budget passes against the real, freshly-seeded safe-scale fixtures", async () => {
      const results = await runAllQueryPlanChecks(getTestSql(), tenantId);

      expect(results.length).toBeGreaterThan(0);

      for (const result of results) {
        expect([result.budgetId, result.ok, result.findings]).toEqual([
          result.budgetId,
          true,
          []
        ]);
      }
    }, 30_000);

    test("ADVERSARIAL PROOF: a deliberately unindexed predicate genuinely produces a Seq Scan on real Postgres, and the gate fails it", async () => {
      const explain = await explainQuery(
        getTestSql(),
        tenantId,
        REGRESSION_FIXTURE_QUERY
      );
      const evaluation = evaluateQueryPlan(explain, REGRESSION_FIXTURE_BUDGET);

      expect(evaluation.observedNodeTypes).toContain("Seq Scan");
      expect(evaluation.ok).toBe(false);
      expect(evaluation.findings.some((f) => f.includes("Seq Scan"))).toBe(
        true
      );
    }, 30_000);

    test("EXPLAIN ANALYZE on the adversarial (read-only) query never mutates row counts", async () => {
      const before = await countAuditEvents(tenantId);
      await explainQuery(getTestSql(), tenantId, REGRESSION_FIXTURE_QUERY);
      const after = await countAuditEvents(tenantId);

      expect(after).toBe(before);
    }, 30_000);

    test("EXPLAIN ANALYZE on the write-shaped budgets (outbox claim UPDATE) always rolls back — running the full check set twice yields identical pending-row counts", async () => {
      const before = await countPendingObjectSyncQueue(tenantId);
      await runAllQueryPlanChecks(getTestSql(), tenantId);
      await runAllQueryPlanChecks(getTestSql(), tenantId);
      const after = await countPendingObjectSyncQueue(tenantId);

      expect(after).toBe(before);
    }, 60_000);

    /**
     * Issue #838's own Definition of Done, executed literally: "verify the
     * budget genuinely catches a regression: temporarily DROP INDEX ->
     * `bun run performance:query-plan:check` must go RED".
     *
     * This is a stronger proof than the `REGRESSION_FIXTURE_QUERY` above,
     * which forces the planner's hand with `SET LOCAL enable_indexscan =
     * off` to synthesize a Seq Scan. Here the regression is the REAL one:
     * the index Issue #830 added is genuinely dropped, and the planner is
     * left completely free to do whatever it likes. What it actually does
     * — and the reason these budgets forbid `Sort` rather than copying the
     * older budgets' `Seq Scan`-only shape — is fall back to the sibling
     * `..._tenant_deleted_idx` and sort on top. A Seq-Scan-only budget
     * would pass that plan; this test would then fail, which is exactly
     * the protection intended.
     *
     * DDL runs on the PRIVILEGED connection (`getAdminSql()`) because the
     * least-privilege `awcms_mini_app` role deliberately does not own
     * these tables. The `finally` block is not optional: the index is
     * real, shared state, and migration 077 is already recorded in the
     * ledger, so `applyMigrations()` would NOT recreate it for any later
     * test in the same database.
     */
    for (const [budgetId, indexName, createIndexSql] of [
      [
        "blog-posts-admin-list",
        "awcms_mini_blog_posts_tenant_updated_idx",
        `CREATE INDEX awcms_mini_blog_posts_tenant_updated_idx
           ON awcms_mini_blog_posts (tenant_id, updated_at DESC)
           WHERE deleted_at IS NULL`
      ],
      [
        "blog-pages-admin-list",
        "awcms_mini_blog_pages_tenant_updated_idx",
        `CREATE INDEX awcms_mini_blog_pages_tenant_updated_idx
           ON awcms_mini_blog_pages (tenant_id, updated_at DESC)
           WHERE deleted_at IS NULL`
      ]
    ] as const) {
      test(`ADVERSARIAL PROOF (Issue #838): actually DROPping ${indexName} makes the ${budgetId} budget go RED, and restoring it makes it green again`, async () => {
        const query = QUERY_PLAN_QUERIES.find((q) => q.id === budgetId)!;
        const budget = QUERY_PLAN_BUDGETS.find((b) => b.id === budgetId)!;

        // Migration 077's own definition, as PostgreSQL normalized it —
        // the exact thing the `finally` block below must put back.
        const originalDef = await indexDefinition(indexName);
        expect([indexName, originalDef === null]).toEqual([indexName, false]);

        // Both sides of the gate, in one test: green BEFORE the drop...
        const before = evaluateQueryPlan(
          await explainQuery(getTestSql(), tenantId, query),
          budget
        );
        expect([budgetId, "before", before.ok, before.findings]).toEqual([
          budgetId,
          "before",
          true,
          []
        ]);

        let regressed: ReturnType<typeof evaluateQueryPlan>;

        try {
          await getAdminSql().unsafe(`DROP INDEX ${indexName}`);

          // Assert the setup ACTUALLY took effect before believing any
          // number that follows it — a silently-skipped DROP would make
          // this test pass for the wrong reason forever.
          expect([indexName, await indexDefinition(indexName)]).toEqual([
            indexName,
            null
          ]);

          regressed = evaluateQueryPlan(
            await explainQuery(getTestSql(), tenantId, query),
            budget
          );
        } finally {
          await getAdminSql().unsafe(createIndexSql);
        }

        // ...RED with the index gone.
        expect([budgetId, "regressed", regressed.ok]).toEqual([
          budgetId,
          "regressed",
          false
        ]);
        expect(regressed.findings.length).toBeGreaterThan(0);

        // The regression is specifically a LOST ORDERING: the planner fell
        // back to another index and bolted a Sort on top. That is the
        // signal this budget is built on, and the finding must name it.
        expect(
          regressed.observedNodeTypes.some((node) => node.includes("Sort"))
        ).toBe(true);
        expect(regressed.findings.some((f) => f.includes("Sort"))).toBe(true);

        // The cost dimension is ALSO asserted now (Issue #849). Before this
        // issue, the `beforeAll` ANALYZE was a silent no-op — issued on the
        // least-privilege `getTestSql()` role, which does not own these
        // tables, so PostgreSQL skipped it with a WARNING and the planner
        // ran on absent/stale statistics whose cost ESTIMATE was meaningless
        // (the dropped-index plan estimated ~8, indistinguishable from the
        // index-present plan). This suite now ANALYZEs via the owning
        // `getAdminSql()` connection and proves it ran, so the estimate is
        // real: the index-present plan measures ~57 (Index Scan, asserted
        // green by `before` above) and the dropped-index plan measures
        // ~316-472 (Bitmap Heap Scan + Sort) against this budget's
        // `maxTotalCost` of 200. Both the plan SHAPE and the COST now carry
        // signal, and both are asserted.
        expect([
          budgetId,
          "regressed cost",
          regressed.rootTotalCost > budget.maxTotalCost
        ]).toEqual([budgetId, "regressed cost", true]);
        expect(regressed.findings.some((f) => f.includes("Total Cost"))).toBe(
          true
        );

        // ...and the index is physically back afterwards, proving the
        // `finally` above really did put the schema back for every later
        // test in this database.
        //
        // Asserted STRUCTURALLY (the index's own normalized definition in
        // pg_indexes) rather than by re-running EXPLAIN: restoring the index
        // is a SCHEMA fact, so assert the schema. The plan-shape/cost
        // guarantee for the restored index is already covered by `before`
        // above. (Note: `CREATE INDEX` refreshes `pg_class.reltuples`/
        // `relpages` but NOT `pg_statistic` column histograms, so re-EXPLAIN
        // after the restore would run on half-refreshed stats — the schema
        // round-trip below is the clean, timing-independent assertion.)
        const restoredDef = await indexDefinition(indexName);

        // Not merely "an index with that name exists" — PostgreSQL's own
        // normalized `indexdef` must be byte-identical to what migration
        // 077 had created before this test dropped it (captured at the top
        // of this test). Same table, same key, same DESC, same partial
        // predicate — a round trip, with no brittle SQL normalization.
        expect([budgetId, restoredDef]).toEqual([budgetId, originalDef]);
      }, 30_000);
    }

    /** PostgreSQL's own normalized definition for one index, or null if it does not exist. */
    async function indexDefinition(indexName: string): Promise<string | null> {
      const rows = (await getAdminSql().unsafe(
        `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
        [indexName]
      )) as { indexdef: string }[];

      return rows[0]?.indexdef ?? null;
    }

    async function countAuditEvents(forTenantId: string): Promise<number> {
      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      return withTenant(
        getTestSql(),
        forTenantId,
        async (tx) => {
          const rows = (await tx`
            SELECT count(*)::int AS row_count FROM awcms_mini_audit_events
            WHERE tenant_id = ${forTenantId}
          `) as { row_count: number }[];
          return rows[0]!.row_count;
        },
        { workClass: "interactive" }
      );
    }

    async function countPendingObjectSyncQueue(
      forTenantId: string
    ): Promise<number> {
      const { withTenant } =
        await import("../../src/lib/database/tenant-context");
      return withTenant(
        getTestSql(),
        forTenantId,
        async (tx) => {
          const rows = (await tx`
            SELECT count(*)::int AS row_count FROM awcms_mini_object_sync_queue
            WHERE tenant_id = ${forTenantId} AND status = 'pending'
          `) as { row_count: number }[];
          return rows[0]!.row_count;
        },
        { workClass: "interactive" }
      );
    }
  }
);
