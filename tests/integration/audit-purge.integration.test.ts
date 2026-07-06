/**
 * Integration tests for `awcms_mini_audit_events` retention/purge
 * (Issue #447) against a real PostgreSQL — the actual DELETE, the actual
 * "purge itself is audited" requirement (doc 04 §Aturan implementasi: "Purge
 * hanya untuk retention/legal hold yang memenuhi syarat... harus diaudit"),
 * batching, and RLS tenant isolation, none of which a pure-unit test can
 * exercise (`purgeExpiredAuditEvents` runs a real transaction via
 * `withTenant`).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import { purgeExpiredAuditEvents } from "../../src/modules/logging/application/audit-purge";

const TENANT_ID = "66666666-6666-6666-6666-666666666666";
const TENANT_B_ID = "77777777-7777-7777-7777-777777777777";

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
  const sql = getTestSql();
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
  const sql = getTestSql();
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

suite("Audit event retention/purge (real Postgres)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_ID, "purge-test-tenant");
  });

  test("deletes events older than the retention cutoff, keeps newer ones, and audits the purge itself", async () => {
    await seedAuditEvent(TENANT_ID, 800, "old-event"); // older than 730-day default
    await seedAuditEvent(TENANT_ID, 10, "recent-event"); // well within retention

    const result = await purgeExpiredAuditEvents(getTestSql(), TENANT_ID);
    expect(result.purgedCount).toBe(1);

    const actions = await fetchAuditActions(TENANT_ID);
    expect(actions).not.toContain("old-event");
    expect(actions).toContain("recent-event");
    // The purge itself must never be silent (doc 04 §Aturan implementasi).
    expect(actions).toContain("purge");
  });

  test("nothing expired: purges zero and writes no purge audit event (no silent no-op noise)", async () => {
    await seedAuditEvent(TENANT_ID, 5, "recent-only");

    const result = await purgeExpiredAuditEvents(getTestSql(), TENANT_ID);
    expect(result.purgedCount).toBe(0);

    const actions = await fetchAuditActions(TENANT_ID);
    expect(actions).toEqual(["recent-only"]);
  });

  test("a stricter custom retentionDays is honored (1-day policy purges a 2-day-old event)", async () => {
    await seedAuditEvent(TENANT_ID, 2, "should-be-purged");

    const result = await purgeExpiredAuditEvents(getTestSql(), TENANT_ID, {
      retentionDays: 1
    });
    expect(result.purgedCount).toBe(1);
  });

  test("looping per batchLimit (the shape scripts/audit-log-purge.ts uses) drains a backlog larger than one batch", async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedAuditEvent(TENANT_ID, 800, `old-${i}`);
    }

    const sql = getTestSql();
    let totalPurged = 0;

    for (let pass = 0; pass < 20; pass += 1) {
      const result = await purgeExpiredAuditEvents(sql, TENANT_ID, {
        batchLimit: 5
      });
      totalPurged += result.purgedCount;

      if (result.purgedCount === 0) {
        break;
      }
    }

    expect(totalPurged).toBe(12);
    // Every purge pass that deleted something wrote its own audit event —
    // 12 rows / batchLimit 5 = 3 non-empty passes (5, 5, 2).
    const actions = await fetchAuditActions(TENANT_ID);
    expect(actions.filter((action) => action === "purge")).toHaveLength(3);
  });

  test("RLS tenant isolation: purging tenant A never touches tenant B's audit events", async () => {
    await seedTenant(TENANT_B_ID, "purge-test-tenant-b");
    await seedAuditEvent(TENANT_ID, 800, "tenant-a-old");
    await seedAuditEvent(TENANT_B_ID, 800, "tenant-b-old");

    await purgeExpiredAuditEvents(getTestSql(), TENANT_ID);

    const tenantAActions = await fetchAuditActions(TENANT_ID);
    expect(tenantAActions).not.toContain("tenant-a-old");

    const tenantBActions = await fetchAuditActions(TENANT_B_ID);
    expect(tenantBActions).toContain("tenant-b-old");
    expect(tenantBActions).not.toContain("purge");
  });
});
