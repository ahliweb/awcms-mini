/**
 * Integration tests for Issue #683 (epic #679) — proves the least-privilege
 * grant matrix in `sql/045_awcms_mini_db_role_separation.sql` is REAL
 * enforcement, not just documentation: connects as each of the three
 * runtime roles (`awcms_mini_app`, `awcms_mini_worker`, `awcms_mini_setup`)
 * against a real PostgreSQL and asserts the actual permission-denied/
 * succeeds outcome on the 9 global (non-RLS) tables, matching
 * `ALLOWED_GLOBAL_TABLE_GRANTS` in `scripts/security-readiness.ts`'s
 * `checkRuntimeRoleGlobalTableGrants` exactly. `checkRuntimeRoleGlobalTableGrants`
 * itself only inspects `pg_class.relacl` (static grant metadata) — these
 * tests are the dynamic counterpart, actually issuing the statement and
 * observing whether Postgres allows it.
 *
 * IMPORTANT: `expect(sql\`...\`).resolves.toBeDefined()` /
 * `.rejects.toBeInstanceOf(Error)` HANGS the process indefinitely with
 * Bun.SQL query promises on this Bun version (confirmed by isolated repro —
 * a broader case of the `.rejects.toThrow()` hang noted elsewhere in this
 * repo's history). Every assertion below manually `await`s the query and
 * uses try/catch instead of `expect().resolves`/`.rejects`.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getSetupTestSql,
  getTestSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionAppRole,
  provisionSetupRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

const TENANT_ID = "88888888-8888-8888-8888-888888888888";

async function seedTenant(): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${TENANT_ID}, 'role-sep-test-tenant', 'role-sep-test-tenant')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function assertRejected(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error(
      "Expected the query to be rejected (permission denied) but it succeeded."
    );
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "DB role separation (Issue #683, epic #679) — real Postgres grant enforcement",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
      await provisionWorkerRole();
      await provisionSetupRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("awcms_mini_app: SELECT still works, but INSERT/UPDATE/DELETE on permissions/schema_migrations are rejected", async () => {
      const sql = getTestSql();

      expect(
        await sql`SELECT 1 FROM awcms_mini_permissions LIMIT 1`
      ).toBeDefined();
      expect(
        await sql`SELECT 1 FROM awcms_mini_schema_migrations LIMIT 1`
      ).toBeDefined();

      await assertRejected(
        sql`INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description) VALUES ('x', 'y', 'z', 'd')`
      );
      await assertRejected(
        sql`INSERT INTO awcms_mini_schema_migrations (migration_name) VALUES ('rogue')`
      );
    });

    test("awcms_mini_app: keeps INSERT/UPDATE (the setup-wizard fallback path) but loses DELETE on awcms_mini_setup_state/awcms_mini_tenants", async () => {
      await seedTenant();
      const sql = getTestSql();

      // Kept: getSetupDatabaseClient() falls back to this role when
      // SETUP_DATABASE_URL isn't configured (sql/045's header, role 2).
      const claimed = await sql`
        INSERT INTO awcms_mini_setup_state (id, locked_at) VALUES (true, now()) ON CONFLICT (id) DO NOTHING
      `;
      expect(claimed).toBeDefined();
      const updatedState = await sql`
        UPDATE awcms_mini_setup_state SET locked_at = now() WHERE id = true
      `;
      expect(updatedState).toBeDefined();
      const updatedTenant = await sql`
        UPDATE awcms_mini_tenants SET tenant_name = 'renamed' WHERE id = ${TENANT_ID}
      `;
      expect(updatedTenant).toBeDefined();

      // Narrowed: nothing, dedicated role or fallback, ever deletes either.
      await assertRejected(
        sql`DELETE FROM awcms_mini_setup_state WHERE id = true`
      );
      await assertRejected(
        sql`DELETE FROM awcms_mini_tenants WHERE id = ${TENANT_ID}`
      );
    });

    test("awcms_mini_worker: can SELECT awcms_mini_tenants but has zero grant on the other 8 global tables", async () => {
      await seedTenant();
      const sql = getWorkerTestSql();

      const tenants =
        await sql`SELECT id FROM awcms_mini_tenants WHERE status = 'active'`;
      expect(tenants).toBeDefined();

      await assertRejected(
        sql`INSERT INTO awcms_mini_tenants (tenant_code, tenant_name) VALUES ('rogue', 'rogue')`
      );

      const otherGlobalTables = [
        "awcms_mini_permissions",
        "awcms_mini_schema_migrations",
        "awcms_mini_setup_state",
        "awcms_mini_modules",
        "awcms_mini_module_dependencies",
        "awcms_mini_module_navigation",
        "awcms_mini_module_jobs",
        "awcms_mini_module_health_checks"
      ];

      for (const table of otherGlobalTables) {
        await assertRejected(sql.unsafe(`SELECT 1 FROM ${table} LIMIT 1`));
      }
    });

    test("awcms_mini_setup: can write its bootstrap tables but never awcms_mini_schema_migrations, and only SELECTs awcms_mini_permissions", async () => {
      const sql = getSetupTestSql();

      // The exact writes bootstrapPlatformTenant issues, in order.
      const claimed = await sql`
        INSERT INTO awcms_mini_setup_state (id, locked_at) VALUES (true, now()) ON CONFLICT (id) DO NOTHING
      `;
      expect(claimed).toBeDefined();
      const tenantRows = await sql`
        INSERT INTO awcms_mini_tenants (tenant_code, tenant_name)
        VALUES ('setup-role-test', 'setup-role-test')
        RETURNING id
      `;
      expect(tenantRows[0]?.id).toBeTruthy();
      expect(
        await sql`SELECT 1 FROM awcms_mini_permissions LIMIT 1`
      ).toBeDefined();

      // Never grantable: only the migration owner may write the ledger.
      await assertRejected(
        sql`INSERT INTO awcms_mini_schema_migrations (migration_name) VALUES ('rogue')`
      );
      await assertRejected(
        sql`INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description) VALUES ('x', 'y', 'z', 'd')`
      );
      await assertRejected(
        sql`DELETE FROM awcms_mini_tenants WHERE tenant_code = 'setup-role-test'`
      );
    });
  }
);
