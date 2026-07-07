/**
 * Integration tests for the module management schema/RLS (Issue #512,
 * epic #510) against a real PostgreSQL. No endpoints/services exist yet
 * (Issue #513 scaffolds the descriptor sync service that will populate
 * these tables for real) — this exercises the migration's constraints and
 * RLS enforcement directly via `withTenant`/raw admin SQL, the same
 * pattern `email-schema.integration.test.ts` (#494) used.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MODULE_KEY = "example_module";
const OTHER_MODULE_KEY = "other_module";

async function seedTenants(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light'),
      (${TENANT_B}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
  `;
}

async function seedModules(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_modules (module_key, module_name, status, version)
    VALUES
      (${MODULE_KEY}, 'Example Module', 'active', '1.0.0'),
      (${OTHER_MODULE_KEY}, 'Other Module', 'active', '1.0.0')
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("module management schema — RLS isolation and constraints", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
    await seedModules();
  });

  test("awcms_mini_modules gained the new columns with sane defaults", async () => {
    const admin = getAdminSql();
    const rows = (await admin`
      SELECT module_type, lifecycle_status, descriptor_version, is_core,
             is_tenant_configurable, updated_at
      FROM awcms_mini_modules WHERE module_key = ${MODULE_KEY}
    `) as {
      module_type: string | null;
      lifecycle_status: string;
      descriptor_version: number;
      is_core: boolean;
      is_tenant_configurable: boolean;
      updated_at: Date;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.module_type).toBeNull();
    expect(rows[0]!.lifecycle_status).toBe("active");
    expect(rows[0]!.descriptor_version).toBe(1);
    expect(rows[0]!.is_core).toBe(false);
    expect(rows[0]!.is_tenant_configurable).toBe(true);
    expect(rows[0]!.updated_at).toBeInstanceOf(Date);
  });

  test("lifecycle_status rejects an unknown value", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        UPDATE awcms_mini_modules SET lifecycle_status = 'bogus'
        WHERE module_key = ${MODULE_KEY}
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("module_type rejects an unknown value but allows null", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        UPDATE awcms_mini_modules SET module_type = 'bogus'
        WHERE module_key = ${MODULE_KEY}
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);

    await admin`
      UPDATE awcms_mini_modules SET module_type = 'system'
      WHERE module_key = ${MODULE_KEY}
    `;
    const rows = (await admin`
      SELECT module_type FROM awcms_mini_modules WHERE module_key = ${MODULE_KEY}
    `) as { module_type: string }[];
    expect(rows[0]!.module_type).toBe("system");
  });

  test("tenant A cannot see tenant B's tenant_modules row", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled)
      VALUES (${TENANT_A}, ${MODULE_KEY}, true), (${TENANT_B}, ${MODULE_KEY}, false)
    `;

    const sql = getDatabaseClient();
    const tenantARows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT enabled FROM awcms_mini_tenant_modules`
    );
    expect(tenantARows).toHaveLength(1);
    expect((tenantARows as { enabled: boolean }[])[0]?.enabled).toBe(true);

    const tenantBRows = await withTenant(
      sql,
      TENANT_B,
      (tx) => tx`SELECT enabled FROM awcms_mini_tenant_modules`
    );
    expect(tenantBRows).toHaveLength(1);
    expect((tenantBRows as { enabled: boolean }[])[0]?.enabled).toBe(false);
  });

  test("querying tenant_modules without a tenant GUC set returns no rows (fail-closed)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key)
      VALUES (${TENANT_A}, ${MODULE_KEY})
    `;

    const sql = getDatabaseClient();
    const rows = await sql`SELECT enabled FROM awcms_mini_tenant_modules`;
    expect(rows).toHaveLength(0);
  });

  test("tenant_modules enforces one row per (tenant, module)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key)
      VALUES (${TENANT_A}, ${MODULE_KEY})
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key)
        VALUES (${TENANT_A}, ${MODULE_KEY})
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("tenant A cannot see tenant B's module_settings row", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_module_settings (tenant_id, module_key, settings)
      VALUES
        (${TENANT_A}, ${MODULE_KEY}, ${{ autoSyncOnBoot: true }}),
        (${TENANT_B}, ${MODULE_KEY}, ${{ autoSyncOnBoot: false }})
    `;

    const sql = getDatabaseClient();
    const tenantARows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT settings FROM awcms_mini_module_settings`
    );
    expect(tenantARows).toHaveLength(1);
    expect(
      (tenantARows as { settings: { autoSyncOnBoot: boolean } }[])[0]?.settings
    ).toEqual({ autoSyncOnBoot: true });
  });

  test("module_dependencies rejects a self-dependency", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_module_dependencies (module_key, depends_on_module_key)
        VALUES (${MODULE_KEY}, ${MODULE_KEY})
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("module_dependencies requires both module keys to already exist", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_module_dependencies (module_key, depends_on_module_key)
        VALUES (${MODULE_KEY}, 'does_not_exist')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);

    const rows = await admin`
      INSERT INTO awcms_mini_module_dependencies (module_key, depends_on_module_key)
      VALUES (${MODULE_KEY}, ${OTHER_MODULE_KEY})
      RETURNING module_key
    `;
    expect(rows).toHaveLength(1);
  });

  test("module_navigation enforces a globally unique path", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_module_navigation (module_key, label_key, path)
      VALUES (${MODULE_KEY}, 'nav.example', '/admin/example')
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_module_navigation (module_key, label_key, path)
        VALUES (${OTHER_MODULE_KEY}, 'nav.other', '/admin/example')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("module_jobs enforces one row per (module, command)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_module_jobs (module_key, command, purpose)
      VALUES (${MODULE_KEY}, 'bun run example:job', 'Example job.')
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_module_jobs (module_key, command, purpose)
        VALUES (${MODULE_KEY}, 'bun run example:job', 'Duplicate.')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("module_health_checks rejects an unknown status and supports a latest-per-module query", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_module_health_checks (module_key, status)
        VALUES (${MODULE_KEY}, 'bogus')
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);

    await admin`
      INSERT INTO awcms_mini_module_health_checks (module_key, status, checked_at)
      VALUES
        (${MODULE_KEY}, 'degraded', now() - interval '1 hour'),
        (${MODULE_KEY}, 'healthy', now())
    `;

    const rows = (await admin`
      SELECT status FROM awcms_mini_module_health_checks
      WHERE module_key = ${MODULE_KEY}
      ORDER BY checked_at DESC
      LIMIT 1
    `) as { status: string }[];

    expect(rows[0]!.status).toBe("healthy");
  });

  test("module_management permission catalog is seeded (no audit.read entry)", async () => {
    const admin = getAdminSql();
    const rows = (await admin`
      SELECT activity_code, action FROM awcms_mini_permissions
      WHERE module_key = 'module_management'
      ORDER BY activity_code, action
    `) as { activity_code: string; action: string }[];

    expect(rows.map((row) => `${row.activity_code}.${row.action}`)).toEqual([
      "health.check",
      "health.read",
      "jobs.read",
      "modules.read",
      "modules.sync",
      "navigation.read",
      "permissions.read",
      "settings.read",
      "settings.update",
      "tenant_modules.disable",
      "tenant_modules.enable",
      "tenant_modules.read"
    ]);
  });
});
