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
import {
  ModuleCompositionInvalidError,
  syncModuleDescriptors
} from "../../src/modules/module-management/application/descriptor-sync";
import { listModules } from "../../src/modules";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";

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

  // Issue #740 security follow-up — PR #769 security-auditor BLOCKED
  // finding, empirically reproduced there: an application module whose
  // `key` collides with a real base module (e.g. "identity_access") used
  // to reach `upsertModule`'s `INSERT ... ON CONFLICT (module_key) DO
  // UPDATE SET ...` and silently overwrite the base module's row, because
  // nothing on this write path (the ONLY path that persists to
  // `awcms_mini_modules`) ever called composition validation —
  // `bun run modules:compose:check` existed as a standalone CI script, but
  // was never actually reachable from here. These tests exercise the ACTUAL
  // write path with a real Postgres instance, not just the (already
  // extensively covered, `tests/unit/module-composition.test.ts`)
  // `composeModuleRegistry` diagnostics in isolation.
  describe("adversarial: a colliding module key must never reach the database (Issue #740 / PR #769 fix)", () => {
    function evilOverride(
      overrides: Partial<ModuleDescriptor> = {}
    ): ModuleDescriptor {
      return {
        key: "identity_access", // collides with the real base module
        name: "Evil Identity Access Override",
        version: "99.99.99",
        status: "active",
        description:
          "Adversarial module attempting to shadow/replace the base identity_access module's row.",
        dependencies: [],
        type: "derived",
        ...overrides
      };
    }

    test("syncModuleDescriptors refuses to sync a descriptor list containing a collision, and writes ZERO rows", async () => {
      const sql = getDatabaseClient();
      const maliciousDescriptors = [...listModules(), evilOverride()];

      let caughtError: unknown;
      try {
        await syncModuleDescriptors(sql, maliciousDescriptors);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ModuleCompositionInvalidError);
      expect(
        (caughtError as ModuleCompositionInvalidError).issues.length
      ).toBeGreaterThan(0);

      // The check runs BEFORE `fetchExistingModules`/any upsert — a
      // rejected sync must never partially write, so NO row exists at
      // all, not even for the non-colliding modules.
      const admin = getAdminSql();
      const rows = (await admin`
        SELECT count(*)::int AS count FROM awcms_mini_modules
      `) as { count: number }[];
      expect(rows[0]?.count).toBe(0);
    });

    test("a prior valid sync's identity_access row is left untouched by a subsequent malicious sync attempt", async () => {
      const sql = getDatabaseClient();
      await syncModuleDescriptors(sql);

      const admin = getAdminSql();
      const before = (await admin`
        SELECT module_name, version FROM awcms_mini_modules WHERE module_key = 'identity_access'
      `) as { module_name: string; version: string }[];
      expect(before[0]?.module_name).not.toBe("Evil Identity Access Override");

      const maliciousDescriptors = [...listModules(), evilOverride()];
      let caughtError: unknown;
      try {
        await syncModuleDescriptors(sql, maliciousDescriptors);
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(ModuleCompositionInvalidError);

      const after = (await admin`
        SELECT module_name, version FROM awcms_mini_modules WHERE module_key = 'identity_access'
      `) as { module_name: string; version: string }[];
      expect(after[0]?.module_name).toBe(before[0]?.module_name);
      expect(after[0]?.version).toBe(before[0]?.version);
      expect(after[0]?.module_name).not.toBe("Evil Identity Access Override");
    });

    test("a self-colliding application registry (two application modules sharing a key) is also rejected, not just base collisions", async () => {
      const sql = getDatabaseClient();
      const maliciousDescriptors = [
        ...listModules(),
        evilOverride({ key: "totally_new_app_module" }),
        evilOverride({ key: "totally_new_app_module", name: "Duplicate" })
      ];

      let caughtError: unknown;
      try {
        await syncModuleDescriptors(sql, maliciousDescriptors);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ModuleCompositionInvalidError);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT count(*)::int AS count FROM awcms_mini_modules
      `) as { count: number }[];
      expect(rows[0]?.count).toBe(0);
    });
  });
});
