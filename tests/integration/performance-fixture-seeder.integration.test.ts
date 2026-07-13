/**
 * Integration tests for the synthetic fixture seeder (Issue #744, epic
 * #738) against a REAL PostgreSQL, as the least-privilege `awcms_mini_app`
 * role — proving the deterministic fixtures actually land correctly under
 * RLS (never via a privileged bypass, see `fixture-seeder.ts`'s own header
 * comment), respect the noisy-neighbor row-count skew, and that RLS
 * cross-tenant isolation holds for the freshly-seeded data (the issue's
 * own "RLS cross-tenant negative tests remain active in the large-data
 * environment" acceptance criterion).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { buildFixturePlan } from "../../src/lib/performance/fixture-generator";
import { seedPerformanceFixtures } from "../../src/lib/performance/fixture-seeder";
import { SAFE_SCALE_PROFILE } from "../../src/lib/performance/scale-profiles";
import { withTenant } from "../../src/lib/database/tenant-context";

const suite = integrationEnabled ? describe : describe.skip;

// A deliberately tiny profile (not `SAFE_SCALE_PROFILE` itself) so this
// specific test suite stays fast — the full `safe` scale is exercised by
// `performance-suite.integration.test.ts` and
// `performance-query-plan-check.integration.test.ts` instead.
const TINY_PROFILE = {
  ...SAFE_SCALE_PROFILE,
  id: "safe" as const,
  tenantCount: 3,
  rowsPerTenant: {
    auditEvents: 40,
    abacDecisionLogs: 20,
    visitorSessions: 10,
    syncOutbox: 10,
    objectSyncQueue: 10,
    idempotencyKeys: 5,
    blogPosts: 5
  },
  noisyNeighborMultiplier: 4
};

suite("performance fixture seeder (Issue #744) — real Postgres", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("seeds deterministic rows for every tenant, matching the planned counts exactly", async () => {
    const plan = buildFixturePlan(TINY_PROFILE, "seeder-it-basic");
    const summary = await seedPerformanceFixtures(getTestSql(), plan);

    expect(summary.tenantCount).toBe(TINY_PROFILE.tenantCount);

    const expectedAuditTotal =
      TINY_PROFILE.rowsPerTenant.auditEvents * (TINY_PROFILE.tenantCount - 1) +
      TINY_PROFILE.rowsPerTenant.auditEvents *
        TINY_PROFILE.noisyNeighborMultiplier;

    expect(summary.rowCounts.auditEvents).toBe(expectedAuditTotal);

    for (const tenant of plan.tenants) {
      const count = await withTenant(
        getTestSql(),
        tenant.tenantId,
        async (tx) => {
          const rows = (await tx`
            SELECT count(*)::int AS row_count FROM awcms_mini_audit_events
            WHERE tenant_id = ${tenant.tenantId}
          `) as { row_count: number }[];
          return rows[0]!.row_count;
        },
        { workClass: "interactive" }
      );

      expect(count).toBe(tenant.rowCounts.auditEvents);
    }
  });

  test("the noisy-neighbor tenant (last in the plan) has visibly more rows than a normal tenant", async () => {
    const plan = buildFixturePlan(TINY_PROFILE, "seeder-it-noisy-neighbor");
    await seedPerformanceFixtures(getTestSql(), plan);

    const noisyNeighbor = plan.tenants[plan.tenants.length - 1]!;
    const normalTenant = plan.tenants[0]!;

    expect(noisyNeighbor.rowCounts.auditEvents).toBeGreaterThan(
      normalTenant.rowCounts.auditEvents
    );
  });

  test("RLS cross-tenant isolation holds for freshly-seeded fixture data", async () => {
    const plan = buildFixturePlan(TINY_PROFILE, "seeder-it-rls");
    await seedPerformanceFixtures(getTestSql(), plan);

    const tenantA = plan.tenants[0]!;
    const tenantB = plan.tenants[1]!;

    // Reading as tenant A must NEVER see tenant B's rows, even though both
    // were seeded through the exact same least-privilege connection.
    const crossTenantRows = await withTenant(
      getTestSql(),
      tenantA.tenantId,
      async (tx) => {
        return (await tx`
          SELECT count(*)::int AS row_count FROM awcms_mini_audit_events
          WHERE tenant_id = ${tenantB.tenantId}
        `) as { row_count: number }[];
      },
      { workClass: "interactive" }
    );

    expect(crossTenantRows[0]!.row_count).toBe(0);
  });

  test("re-running buildFixturePlan+seed with the SAME seed against a fresh database reproduces identical row counts (reproducibility)", async () => {
    const planFirst = buildFixturePlan(TINY_PROFILE, "seeder-it-reproducible");
    const firstSummary = await seedPerformanceFixtures(getTestSql(), planFirst);

    await resetDatabase();

    const planSecond = buildFixturePlan(TINY_PROFILE, "seeder-it-reproducible");
    const secondSummary = await seedPerformanceFixtures(
      getTestSql(),
      planSecond
    );

    expect(secondSummary.rowCounts).toEqual(firstSummary.rowCounts);
    expect(planSecond.tenants.map((t) => t.tenantId)).toEqual(
      planFirst.tenants.map((t) => t.tenantId)
    );
  });
});
