/**
 * Integration tests for `scripts/audit-log-purge.ts`'s migration to the
 * shared worker runner (`src/lib/jobs/job-runner.ts`, Issue #697, epic
 * #679) against a real PostgreSQL.
 *
 * Deliberately does NOT re-test `purgeExpiredAuditEvents`'s own retention/
 * batching/audit-event behavior — that is already covered end-to-end by
 * `tests/integration/audit-purge.integration.test.ts` (the exact same
 * function this script calls). This file only covers what the MIGRATION
 * changed/added: the script's own `runAuditLogPurge` tenant-iteration
 * wrapper still produces the exact same DB effects as calling
 * `purgeExpiredAuditEvents` directly per tenant (regression), the new
 * `--dry-run` counting mode never mutates anything, and that
 * `iterateTenantsInBatches` correctly drains a multi-pass backlog under a
 * real Postgres connection running as the actual `awcms_mini_worker` role
 * `bun run logs:audit:purge` uses in production.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import { runAuditLogPurge } from "../../scripts/audit-log-purge";

const TENANT_ID = "aaaaaaaa-1111-1111-1111-111111111111";
const TENANT_B_ID = "aaaaaaaa-2222-2222-2222-222222222222";

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${id}, ${code}, ${code})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedAuditEvent(
  tenantId: string,
  ageInDays: number,
  action: string
): Promise<void> {
  const sql = getWorkerTestSql();
  await withTenant(sql, tenantId, async (tx) => {
    await tx`
      INSERT INTO awcms_mini_audit_events
        (tenant_id, module_key, action, resource_type, severity, message, created_at)
      VALUES (
        ${tenantId}, 'logging', ${action}, 'seed_resource', 'info', 'seed event',
        now() - (${String(ageInDays)} || ' days')::interval
      )
    `;
  });
}

async function fetchAuditActions(tenantId: string): Promise<string[]> {
  const sql = getWorkerTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at
    `) as { action: string }[];

    return rows.map((row) => row.action);
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("runAuditLogPurge (migrated to shared worker runner, Issue #697)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_ID, "job-purge-tenant-a");
  });

  test("non-dry-run: purges expired rows and writes the purge audit event — identical effect to calling purgeExpiredAuditEvents directly (regression)", async () => {
    await seedAuditEvent(TENANT_ID, 800, "old-event"); // older than 730-day default
    await seedAuditEvent(TENANT_ID, 10, "recent-event");

    const result = await runAuditLogPurge(getWorkerTestSql(), {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });

    expect(result.totalPurged).toBe(1);
    expect(result.tenantsChecked).toBeGreaterThanOrEqual(1);

    const actions = await fetchAuditActions(TENANT_ID);
    expect(actions).not.toContain("old-event");
    expect(actions).toContain("recent-event");
    expect(actions).toContain("purge");
  });

  test("--dry-run: reports the count that WOULD be purged, deletes nothing, writes no purge audit event", async () => {
    await seedAuditEvent(TENANT_ID, 800, "old-event");
    await seedAuditEvent(TENANT_ID, 10, "recent-event");

    const result = await runAuditLogPurge(getWorkerTestSql(), {
      dryRun: true,
      correlationId: crypto.randomUUID()
    });

    expect(result.totalPurged).toBe(1);

    const actions = await fetchAuditActions(TENANT_ID);
    // Nothing was actually deleted, and no purge audit event was written.
    expect(actions).toContain("old-event");
    expect(actions).toContain("recent-event");
    expect(actions).not.toContain("purge");
  });

  test("bounded batching: a backlog larger than one batch is fully drained across multiple passes via iterateTenantsInBatches, never in one unbounded transaction", async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedAuditEvent(TENANT_ID, 800, `old-${i}`);
    }

    const result = await runAuditLogPurge(
      getWorkerTestSql(),
      { dryRun: false, correlationId: crypto.randomUUID() },
      { batchLimit: 5 }
    );

    expect(result.totalPurged).toBe(12);

    const actions = await fetchAuditActions(TENANT_ID);
    // 12 rows / batchLimit 5 = 3 non-empty passes (5, 5, 2), each purge
    // pass wrote its own audit event.
    expect(actions.filter((action) => action === "purge")).toHaveLength(3);
  });

  test("RLS tenant isolation is preserved: each tenant's per-tenant transaction only ever purges its OWN expired rows, never another tenant's — tenant B's still-fresh data survives even though the job iterates every active tenant in the same run", async () => {
    await seedTenant(TENANT_B_ID, "job-purge-tenant-b");
    await seedAuditEvent(TENANT_ID, 800, "tenant-a-old"); // expired for tenant A
    await seedAuditEvent(TENANT_B_ID, 10, "tenant-b-fresh"); // NOT expired for tenant B

    const result = await runAuditLogPurge(getWorkerTestSql(), {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });

    expect(result.totalPurged).toBe(1);

    const tenantAActions = await fetchAuditActions(TENANT_ID);
    expect(tenantAActions).not.toContain("tenant-a-old");
    expect(tenantAActions).toContain("purge");

    const tenantBActions = await fetchAuditActions(TENANT_B_ID);
    expect(tenantBActions).toContain("tenant-b-fresh");
    expect(tenantBActions).not.toContain("purge");
  });

  test("runs successfully under the real awcms_mini_worker role (Issue #683, epic #679)", async () => {
    await seedAuditEvent(TENANT_ID, 800, "worker-role-old");

    const result = await runAuditLogPurge(getWorkerTestSql(), {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });

    expect(result.totalPurged).toBe(1);
  });
});
