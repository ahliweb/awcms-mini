/**
 * Integration tests for the descriptor sync service (Issue #513, epic
 * #510) against a real PostgreSQL: real `listModules()` synced into
 * `awcms_mini_modules`/`_dependencies`/`_navigation`/`_jobs`, idempotency
 * across repeated runs, and orphan detection/marking.
 *
 * Runs on the plain app-role connection (`getDatabaseClient()`), not the
 * admin/migration connection — proving the least-privilege
 * `awcms_mini_app` role (migration 013's default-privileges grant) can
 * actually write to these new global tables without any special
 * connection.
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
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";
import { listModules } from "../../src/modules";

const suite = integrationEnabled ? describe : describe.skip;

suite("module descriptor sync service", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("first run creates every registered module", async () => {
    const sql = getDatabaseClient();
    const result = await syncModuleDescriptors(sql);

    expect(result.created.sort()).toEqual(
      [...listModules()].map((m) => m.key).sort()
    );
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.orphaned).toEqual([]);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_modules
    `) as { count: number }[];
    expect(rows[0]?.count).toBe(listModules().length);
  });

  test("second run with identical descriptors reports everything unchanged", async () => {
    const sql = getDatabaseClient();
    await syncModuleDescriptors(sql);
    const second = await syncModuleDescriptors(sql);

    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual(
      [...listModules()].map((m) => m.key).sort()
    );
  });

  test("syncs dependency rows for a module with dependencies", async () => {
    const sql = getDatabaseClient();
    await syncModuleDescriptors(sql);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT depends_on_module_key FROM awcms_mini_module_dependencies
      WHERE module_key = 'email'
      ORDER BY depends_on_module_key
    `) as { depends_on_module_key: string }[];

    expect(rows.map((r) => r.depends_on_module_key)).toEqual(
      ["identity_access", "profile_identity", "tenant_admin"].sort()
    );
  });

  test("re-syncing after a descriptor field changes reports an update", async () => {
    const sql = getDatabaseClient();
    await syncModuleDescriptors(sql);

    const bumped = listModules().map((descriptor) =>
      descriptor.key === "email"
        ? { ...descriptor, version: "9.9.9" }
        : descriptor
    );
    const result = await syncModuleDescriptors(sql, bumped);

    expect(result.updated).toEqual(["email"]);
    expect(result.created).toEqual([]);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT version FROM awcms_mini_modules WHERE module_key = 'email'
    `) as { version: string }[];
    expect(rows[0]?.version).toBe("9.9.9");
  });

  test("a module removed from the descriptor list is marked disabled, not deleted", async () => {
    const sql = getDatabaseClient();
    await syncModuleDescriptors(sql);

    const withoutEmail = listModules().filter((d) => d.key !== "email");
    const result = await syncModuleDescriptors(sql, withoutEmail);

    expect(result.orphaned).toEqual(["email"]);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT lifecycle_status FROM awcms_mini_modules WHERE module_key = 'email'
    `) as { lifecycle_status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lifecycle_status).toBe("disabled");
  });

  test("running sync a third time does not re-mark an already-orphaned module", async () => {
    const sql = getDatabaseClient();
    await syncModuleDescriptors(sql);

    const withoutEmail = listModules().filter((d) => d.key !== "email");
    await syncModuleDescriptors(sql, withoutEmail);
    const third = await syncModuleDescriptors(sql, withoutEmail);

    expect(third.orphaned).toEqual(["email"]);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT lifecycle_status FROM awcms_mini_modules WHERE module_key = 'email'
    `) as { lifecycle_status: string }[];
    expect(rows[0]?.lifecycle_status).toBe("disabled");
  });
});
