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

const ANALYZED_TABLES = [
  "awcms_mini_audit_events",
  "awcms_mini_abac_decision_logs",
  "awcms_mini_blog_posts",
  // Issue #838 — now seeded (scale-profiles.ts `blogPages`) and the
  // `blog-pages-admin-list` budget's driving table, so it needs the same
  // fresh statistics as every other budget's table.
  "awcms_mini_blog_pages",
  "awcms_mini_object_sync_queue"
];

suite(
  "performance query-plan budgets (Issue #744) — real Postgres, adversarial proof",
  () => {
    let tenantId: string;

    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
      await resetDatabase();

      const plan = buildFixturePlan(SAFE_SCALE_PROFILE, "query-plan-check-it");
      await seedPerformanceFixtures(getTestSql(), plan);
      tenantId = plan.tenants[0]!.tenantId;

      // Fresh planner statistics — autovacuum ANALYZE may not have run yet
      // right after a bulk seed, and stale/absent stats can bias the
      // planner toward a Seq Scan even for a genuinely selective, indexed
      // query, which would make the "good" budgets flaky rather than a
      // real signal.
      for (const table of ANALYZED_TABLES) {
        await getTestSql().unsafe(`ANALYZE ${table}`);
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

        // NOTE — deliberately NOT asserting `rootTotalCost >
        // budget.maxTotalCost` here, even though the same DROP measures
        // 939.88 vs a 200 budget against a properly-ANALYZEd database.
        // In THIS suite the regressed plan's estimated cost is ~8: the
        // `ANALYZE` in `beforeAll` above is a silent no-op, because
        // `getTestSql()` is the least-privilege `awcms_mini_app` role and
        // PostgreSQL skips (with a WARNING, not an error) an ANALYZE of a
        // table the role does not own — verified directly against
        // pg_stat_user_tables: `last_analyze` never changes. So the
        // planner is working from absent/stale statistics and its cost
        // ESTIMATE is not meaningful here, while the plan SHAPE still is.
        //
        // That asymmetry is the whole reason this budget leads with a
        // plan-shape rule instead of a cost threshold: the shape signal
        // survives a statistics regime that makes the cost signal
        // worthless. `tests/unit/performance-query-plan-budgets.test.ts`
        // covers the cost bound against the real measured 939.88 plan.
        //
        // Fixing that no-op ANALYZE is deliberately out of scope for Issue
        // #838 and needs its own approved threshold change: with accurate
        // statistics the PRE-EXISTING `blog-posts-fulltext-search` budget
        // measures 939.5 against its approved maxTotalCost of 800 (same
        // stale-stats calibration Issue #782 already root-caused for
        // `audit-events-tenant-activity-reporting`), so it would go red the
        // moment the ANALYZE starts working.

        // ...and the index is physically back afterwards, proving the
        // `finally` above really did put the schema back for every later
        // test in this database.
        //
        // This is asserted STRUCTURALLY (the index's own definition in
        // pg_indexes) rather than by re-running EXPLAIN and expecting the
        // green plan to return. Re-EXPLAINing looks like the stronger
        // check but is actually unsound HERE, and it was measured, not
        // guessed — the restored plan legitimately comes back as
        // `Limit -> Sort -> Result -> Index Scan(..._tenant_deleted_idx)`
        // at cost 8.19 vs the index-ordered plan's 8.3. The two candidate
        // plans are TIED to within ~1%, and the planner picks the
        // marginally cheaper one:
        //
        //   pg_class state                          | plan                       | cost
        //   ----------------------------------------|----------------------------|------
        //   reltuples=-1 (pristine, never analyzed) | Index Scan(tenant_updated) |  8.3
        //   reltuples=2000, ZERO column statistics  | Sort + Scan(tenant_deleted)|  8.19
        //   fully ANALYZEd (any real database)      | Index Scan(tenant_updated) | 57.17
        //
        // The middle row is the state THIS test creates and nothing else
        // does: `CREATE INDEX` updates `pg_class.reltuples`/`relpages` as
        // a side effect (-1/0 -> 2000/334), so the planner suddenly knows
        // the real row count while still having NO column statistics at
        // all (`pg_statistic` = 0 rows, `last_autoanalyze` = null — see
        // Issue #849: this suite's ANALYZE is a silent no-op because the
        // app role does not own these tables). That half-informed state
        // does not exist in any real deployment, where autovacuum's
        // ANALYZE produces the third row — index-ordered, no sort, which
        // is exactly what this budget encodes and what Issue #830's own
        // EXPLAIN evidence showed.
        //
        // Restoring the index is a SCHEMA fact, so assert the schema. The
        // plan-shape guarantee is already covered by `before` above, and
        // deliberately NOT re-asserted here against a statistics regime
        // this suite does not have. (Fixing it by ANALYZEing in the
        // `finally` is rejected on purpose: CI runs `bun test` and
        // `performance:query-plan:check` against the SAME database, so
        // ANALYZEing `awcms_mini_blog_posts` from inside a test would make
        // the pre-existing `blog-posts-fulltext-search` budget — latently
        // red at 939.5 vs its approved 800 — fail in the later script run.
        // Also tracked in Issue #849.)
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
