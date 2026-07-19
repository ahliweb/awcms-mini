/**
 * Integration tests for the tenant-module matrix admin screen (Issue #566,
 * epic #555) — `/admin/modules/tenants`. Single-tenant scope (see that
 * page's own docblock and `module-management/README.md` §Tenant-module
 * matrix admin UI for the full, maintainer-confirmed scope decision): this
 * is NOT a cross-tenant view, so these tests never assert anything about a
 * second tenant seeing another tenant's matrix — RLS isolation for
 * `awcms_mini_tenant_modules` is already proven by
 * `module-tenant-lifecycle.integration.test.ts`'s own RLS test and is not
 * re-proven here.
 *
 * Follows this repo's established convention for admin-page integration
 * tests (see `blog-content-admin-ui.integration.test.ts`'s own docblock):
 * exercises the SSR data-loading function (`fetchModuleMatrix`) and the
 * real, already-guarded/audited mutation endpoints
 * (`/api/v1/tenant/modules/{moduleKey}/enable|disable`) directly. There is
 * no browser/SSR render harness in this repo for `.astro` pages, so
 * client-side-only behavior (type/status filters, the "only show warnings"
 * checkbox, and the StateNotice empty/error branches — all pure Astro
 * conditional rendering) is NOT covered here; it is smoke-tested manually
 * against a real dev server per this repo's UI-change convention.
 *
 * Coverage map against the issue's testing checklist:
 *   - "permission-gating (denied without module_management.modules.read)":
 *     the page's own SSR permission check is the generic
 *     `context.permissions.has(...)` pattern every admin page already uses
 *     (not new logic to re-test); what IS new and load-bearing is that
 *     hiding a button in this screen is never the only enforcement — proven
 *     below by calling the real enable/disable endpoints as a caller
 *     without `module_management.tenant_modules.*` permissions and
 *     asserting `403`.
 *   - "empty state": not applicable at this layer — `fetchModuleMatrix`
 *     always returns one row per registered module in this app's fixed
 *     registry (never legitimately empty); the page's own empty branch
 *     (`rows.length === 0`) is dead code protecting against a
 *     theoretical empty registry, not a state these tests can produce.
 *   - "populated state with health/dependency data": covered by the
 *     health-inclusion-toggle test and both warning-direction tests below.
 *   - "enable/disable mutation through the real API with a real audit-event
 *     assertion", "core-module-cannot-be-disabled enforcement": covered
 *     directly.
 *   - "preset application through this screen": NOT built in this issue
 *     (see this screen's own docblock for why) — no test for it here.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as enableModule } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/enable";
import { POST as disableModule } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/disable";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { listModules } from "../../src/modules";
import { fetchModuleMatrix } from "../../src/modules/module-management/application/module-matrix";
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string; tenantUserId: string };

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

function authHeaders(owner: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`
  };
}

/** Mirrors `module-catalog.integration.test.ts`'s own helper. */
async function provisionNoPermissionUser(
  tenantId: string
): Promise<{ token: string }> {
  const password = "integration-test-no-permission-password";
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'No Permission') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, 'no-permission@example.com', ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id})
    `;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier: "no-permission@example.com", password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { token: login.body.data.token };
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "tenant-module matrix admin screen (fetchModuleMatrix + real API)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("fetchModuleMatrix returns one row per registered module, health only computed when requested", async () => {
      const owner = await bootstrap();
      const sql = getDatabaseClient();

      const withoutHealth = await withTenant(sql, owner.tenantId, (tx) =>
        fetchModuleMatrix(tx, owner.tenantId, { includeHealth: false })
      );
      expect(withoutHealth.length).toBe(listModules().length);
      expect(withoutHealth.every((row) => row.healthStatus === null)).toBe(
        true
      );

      const withHealth = await withTenant(sql, owner.tenantId, (tx) =>
        fetchModuleMatrix(tx, owner.tenantId, { includeHealth: true })
      );
      expect(
        withHealth.every((row) => typeof row.healthStatus === "string")
      ).toBe(true);
    });

    test("default tenant state: every module enabled except default-disabled control-plane, core/protected flags match resolveProtectedModuleKeys", async () => {
      const owner = await bootstrap();
      const sql = getDatabaseClient();

      const rows = await withTenant(sql, owner.tenantId, (tx) =>
        fetchModuleMatrix(tx, owner.tenantId, { includeHealth: false })
      );
      // Issue #870 (ADR-0022 §7): `service_catalog` is `defaultTenantState:
      // "disabled"`, so with no explicit tenant_modules row it resolves
      // DISABLED here — every OTHER module is enabled by default.
      expect(
        rows
          .filter((row) => row.moduleKey !== "service_catalog")
          .every((row) => row.tenantEnabled)
      ).toBe(true);
      expect(
        rows.find((row) => row.moduleKey === "service_catalog")?.tenantEnabled
      ).toBe(false);
      expect(rows.every((row) => row.dependencyWarning === null)).toBe(true);

      const byKey = new Map(rows.map((row) => [row.moduleKey, row]));
      expect(byKey.get("module_management")?.isCore).toBe(true);
      expect(byKey.get("module_management")?.isProtected).toBe(true);
      for (const key of [
        "tenant_admin",
        "identity_access",
        "profile_identity"
      ]) {
        expect(byKey.get(key)?.isCore).toBe(false);
        expect(byKey.get(key)?.isProtected).toBe(true);
      }
      expect(byKey.get("blog_content")?.isProtected).toBe(false);
    });

    test("email shows a reverseDependencyWarning because reporting still depends on it, matching the real 409 disabling email would hit", async () => {
      const owner = await bootstrap();
      const sql = getDatabaseClient();

      const rows = await withTenant(sql, owner.tenantId, (tx) =>
        fetchModuleMatrix(tx, owner.tenantId, { includeHealth: false })
      );
      const email = rows.find((row) => row.moduleKey === "email");
      expect(email?.reverseDependencyWarning?.code).toBe(
        "MODULE_REVERSE_DEPENDENCY_ACTIVE"
      );
      expect(email?.reverseDependencyWarning?.message).toContain("reporting");
      expect(email?.dependencyWarning).toBeNull();

      const disableResult = await invoke(disableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/email/disable",
        headers: authHeaders(owner),
        params: { moduleKey: "email" },
        body: { reason: "Trying to disable a relied-upon module." }
      });
      expect(disableResult.status).toBe(409);
    });

    test("form_drafts shows a dependencyWarning once identity_access is force-disabled, matching the real 409 re-enabling form_drafts would hit", async () => {
      const owner = await bootstrap();
      const admin = getAdminSql();

      // Same forced-state setup as
      // `module-tenant-lifecycle.integration.test.ts`'s own
      // MODULE_DEPENDENCY_DISABLED test — direct DB rows, bypassing the
      // endpoints on purpose (the real disable flow would never reach this
      // state on its own, since identity_access has active reverse
      // dependents).
      await syncModuleDescriptors(admin);
      await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled, disabled_at)
      VALUES (${owner.tenantId}, 'identity_access', false, now())
    `;
      await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled, disabled_at)
      VALUES (${owner.tenantId}, 'form_drafts', false, now())
    `;

      const sql = getDatabaseClient();
      const rows = await withTenant(sql, owner.tenantId, (tx) =>
        fetchModuleMatrix(tx, owner.tenantId, { includeHealth: false })
      );
      const formDrafts = rows.find((row) => row.moduleKey === "form_drafts");
      expect(formDrafts?.tenantEnabled).toBe(false);
      expect(formDrafts?.dependencyWarning?.code).toBe(
        "MODULE_DEPENDENCY_DISABLED"
      );
      expect(formDrafts?.reverseDependencyWarning).toBeNull();

      const enableResult = await invoke(enableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/enable",
        headers: authHeaders(owner),
        params: { moduleKey: "form_drafts" }
      });
      expect(enableResult.status).toBe(409);
    });

    test("module_management is core: the matrix flags it, and the real disable endpoint this screen calls enforces it server-side", async () => {
      const owner = await bootstrap();
      const sql = getDatabaseClient();

      const rows = await withTenant(sql, owner.tenantId, (tx) =>
        fetchModuleMatrix(tx, owner.tenantId, { includeHealth: false })
      );
      expect(
        rows.find((r) => r.moduleKey === "module_management")?.isCore
      ).toBe(true);

      const result = await invoke(disableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/module_management/disable",
        headers: authHeaders(owner),
        params: { moduleKey: "module_management" },
        body: { reason: "Trying to disable module management itself." }
      });
      expect(result.status).toBe(409);
    });

    test("disabling then re-enabling a module through the real API this screen's buttons call writes real audit events", async () => {
      const owner = await bootstrap();

      const disableResult = await invoke(disableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/disable",
        headers: authHeaders(owner),
        params: { moduleKey: "form_drafts" },
        body: { reason: "Matrix screen test." }
      });
      expect(disableResult.status).toBe(200);

      const enableResult = await invoke(enableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/enable",
        headers: authHeaders(owner),
        params: { moduleKey: "form_drafts" }
      });
      expect(enableResult.status).toBe(200);

      const admin = getAdminSql();
      const auditRows = (await admin`
      SELECT action, resource_id FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = 'form_drafts'
      ORDER BY created_at ASC
    `) as { action: string; resource_id: string }[];
      expect(auditRows.map((r) => r.action)).toEqual([
        "tenant_module_disabled",
        "tenant_module_enabled"
      ]);
    });

    test("disable via the API requires a non-empty reason (same contract this screen's window.prompt() flow relies on)", async () => {
      const owner = await bootstrap();

      const result = await invoke(disableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/disable",
        headers: authHeaders(owner),
        params: { moduleKey: "form_drafts" },
        body: {}
      });
      expect(result.status).toBe(400);
    });

    test("a caller without module_management.tenant_modules permissions is denied by the real endpoints this screen's buttons call — hiding the button is never the only enforcement", async () => {
      const owner = await bootstrap();
      const noPermission = await provisionNoPermissionUser(owner.tenantId);
      const headers = {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${noPermission.token}`
      };

      const disableResult = await invoke(disableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/disable",
        headers,
        params: { moduleKey: "form_drafts" },
        body: { reason: "Should be denied." }
      });
      expect(disableResult.status).toBe(403);

      const enableResult = await invoke(enableModule, {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/enable",
        headers,
        params: { moduleKey: "form_drafts" }
      });
      expect(enableResult.status).toBe(403);
    });
  }
);
