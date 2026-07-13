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
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { evaluateQueryPlan } from "../../src/lib/performance/query-plan-budgets";
import { buildFixturePlan } from "../../src/lib/performance/fixture-generator";
import { seedPerformanceFixtures } from "../../src/lib/performance/fixture-seeder";
import {
  explainQuery,
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
