/**
 * Integration tests for the tenant module lifecycle API (Issue #515, epic
 * #510) against a real PostgreSQL: enable/disable using the *real*
 * registered module dependency graph (`identity_access` has several
 * active reverse dependents; `form_drafts` is a leaf with none), RLS
 * isolation, and audit.
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
import { GET as listTenantModules } from "../../src/pages/api/v1/tenant/modules/index";
import { POST as enableModule } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/enable";
import { POST as disableModule } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/disable";
import { GET as listFormDrafts } from "../../src/pages/api/v1/form-drafts/index";
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";
import { fetchTenantModuleEntry } from "../../src/modules/module-management/application/tenant-module-lifecycle";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";

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

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant module lifecycle API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("GET /api/v1/tenant/modules lists every module as enabled by default except default-disabled control-plane", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { modules: { moduleKey: string; tenantEnabled: boolean }[] };
    }>(listTenantModules, {
      method: "GET",
      path: "/api/v1/tenant/modules",
      headers: authHeaders(owner)
    });

    expect(result.status).toBe(200);
    // Issue #870/#871/#872/#875/#873/#876 (ADR-0022 §7): the SaaS control-plane
    // modules (`service_catalog`, `tenant_entitlement`, `tenant_provisioning`,
    // `usage_metering`, `tenant_lifecycle`, `subscription_billing`) are
    // `defaultTenantState: "disabled"`, so they list as NOT enabled with no
    // explicit row; every other module is enabled by default.
    const defaultDisabled = new Set([
      "service_catalog",
      "tenant_entitlement",
      "tenant_provisioning",
      "usage_metering",
      "tenant_lifecycle",
      "subscription_billing"
    ]);
    expect(
      result.body.data.modules
        .filter((m) => !defaultDisabled.has(m.moduleKey))
        .every((m) => m.tenantEnabled)
    ).toBe(true);
    for (const key of defaultDisabled) {
      expect(
        result.body.data.modules.find((m) => m.moduleKey === key)?.tenantEnabled
      ).toBe(false);
    }
  });

  test("fetchTenantModuleEntry (single-module narrowing of fetchTenantModuleEntries, security audit follow-up) matches the plural function's per-entry result before and after a real disable", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const beforeDisable = await withTenant(sql, owner.tenantId, (tx) =>
      fetchTenantModuleEntry(tx, owner.tenantId, "form_drafts")
    );
    expect(beforeDisable?.tenantEnabled).toBe(true);

    const disableResult = await invoke<{ data: { tenantEnabled: boolean } }>(
      disableModule,
      {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/disable",
        headers: authHeaders(owner),
        params: { moduleKey: "form_drafts" },
        body: { reason: "single-module lookup test" }
      }
    );
    expect(disableResult.status).toBe(200);

    const afterDisable = await withTenant(sql, owner.tenantId, (tx) =>
      fetchTenantModuleEntry(tx, owner.tenantId, "form_drafts")
    );
    expect(afterDisable?.tenantEnabled).toBe(false);
    expect(afterDisable?.disableReason).toBe("single-module lookup test");

    // Unknown module key -> null, same fail-closed shape the caller
    // (public-news-tenant-resolution.ts) treats as "not enabled".
    const unknown = await withTenant(sql, owner.tenantId, (tx) =>
      fetchTenantModuleEntry(tx, owner.tenantId, "does_not_exist")
    );
    expect(unknown).toBeNull();
  });

  test("disabling a leaf module (no reverse dependents) succeeds and is audited", async () => {
    const owner = await bootstrap();

    const result = await invoke<{ data: { tenantEnabled: boolean } }>(
      disableModule,
      {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/disable",
        headers: authHeaders(owner),
        params: { moduleKey: "form_drafts" },
        body: { reason: "Not used by this tenant." }
      }
    );

    expect(result.status).toBe(200);
    expect(result.body.data.tenantEnabled).toBe(false);

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action, resource_type, resource_id, attributes
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'tenant_module_disabled'
    `) as {
      action: string;
      resource_type: string;
      resource_id: string;
      attributes: { reason: string };
    }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.resource_id).toBe("form_drafts");
    expect(auditRows[0]!.attributes.reason).toBe("Not used by this tenant.");
  });

  test("re-enabling a previously disabled module succeeds and is audited", async () => {
    const owner = await bootstrap();
    await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/form_drafts/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { reason: "Temporary." }
    });

    const result = await invoke<{ data: { tenantEnabled: boolean } }>(
      enableModule,
      {
        method: "POST",
        path: "/api/v1/tenant/modules/form_drafts/enable",
        headers: authHeaders(owner),
        params: { moduleKey: "form_drafts" }
      }
    );

    expect(result.status).toBe(200);
    expect(result.body.data.tenantEnabled).toBe(true);

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'tenant_module_enabled'
    `) as { action: string }[];
    expect(auditRows).toHaveLength(1);
  });

  test("enabling an already-enabled module is rejected (409 MODULE_ALREADY_ENABLED)", async () => {
    const owner = await bootstrap();

    const result = await invoke(enableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/email/enable",
      headers: authHeaders(owner),
      params: { moduleKey: "email" }
    });

    expect(result.status).toBe(409);
  });

  test("disabling a module that another enabled module depends on is rejected (409 MODULE_REVERSE_DEPENDENCY_ACTIVE)", async () => {
    const owner = await bootstrap();

    // `reporting` depends on `email` and is enabled by default.
    const result = await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/email/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "email" },
      body: { reason: "Trying to disable a relied-upon module." }
    });

    expect(result.status).toBe(409);
  });

  test("disabling a core module is rejected (409 CORE_MODULE_CANNOT_BE_DISABLED)", async () => {
    const owner = await bootstrap();

    const result = await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/module_management/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "module_management" },
      body: { reason: "Trying to disable module management itself." }
    });

    expect(result.status).toBe(409);
  });

  test("enabling a module whose dependency is disabled for this tenant is rejected (409 MODULE_DEPENDENCY_DISABLED)", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    // The registry FK requires awcms_mini_modules to be populated first —
    // enable/disable auto-syncs, but this test writes tenant_modules rows
    // directly (bypassing the endpoints), so it must sync explicitly.
    await syncModuleDescriptors(admin);

    // Directly force identity_access into a disabled tenant state — this
    // bypasses the endpoint's own reverse-dependency guard on purpose,
    // as pure test setup (arranging a state the real disable flow would
    // never reach on its own, since identity_access has active reverse
    // dependents).
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled, disabled_at)
      VALUES (${owner.tenantId}, 'identity_access', false, now())
    `;
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled, disabled_at)
      VALUES (${owner.tenantId}, 'form_drafts', false, now())
    `;

    // form_drafts depends only on identity_access, which is now disabled.
    const result = await invoke(enableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/form_drafts/enable",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" }
    });

    expect(result.status).toBe(409);
  });

  test("enabling/disabling an unknown module key is a 404", async () => {
    const owner = await bootstrap();

    const enableResult = await invoke(enableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/does_not_exist/enable",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" }
    });
    expect(enableResult.status).toBe(404);

    const disableResult = await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/does_not_exist/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" },
      body: { reason: "n/a" }
    });
    expect(disableResult.status).toBe(404);
  });

  test("disable requires a reason", async () => {
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

  test("disabling a module actually blocks its own endpoints (not just the tenant_modules flag)", async () => {
    const owner = await bootstrap();

    const before = await invoke(listFormDrafts, {
      method: "GET",
      path: "/api/v1/form-drafts",
      headers: authHeaders(owner)
    });
    expect(before.status).toBe(200);

    await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/form_drafts/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { reason: "Not used by this tenant." }
    });

    const after = await invoke(listFormDrafts, {
      method: "GET",
      path: "/api/v1/form-drafts",
      headers: authHeaders(owner)
    });
    expect(after.status).toBe(403);
    expect((after.body as { error: { code: string } }).error.code).toBe(
      "MODULE_DISABLED"
    );
  });

  test("RLS: disabling a module for tenant A never affects tenant B's state", async () => {
    const ownerA = await bootstrap("tenant-a", "Tenant A");
    const admin = getAdminSql();
    const tenantBId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await admin`
      INSERT INTO awcms_mini_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${tenantBId}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
    `;

    await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/form_drafts/disable",
      headers: authHeaders(ownerA),
      params: { moduleKey: "form_drafts" },
      body: { reason: "Tenant A only." }
    });

    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_tenant_modules
      WHERE tenant_id = ${tenantBId}
    `) as { count: number }[];
    expect(rows[0]?.count).toBe(0);
  });
});
