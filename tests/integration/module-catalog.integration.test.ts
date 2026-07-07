/**
 * Integration tests for the module catalog API (Issue #514, epic #510)
 * against a real PostgreSQL: list/detail/sync, ABAC, safe 404, and audit
 * on sync.
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
import { GET as listModulesRoute } from "../../src/pages/api/v1/modules/index";
import { GET as getModuleDetail } from "../../src/pages/api/v1/modules/[moduleKey]";
import { POST as syncModulesRoute } from "../../src/pages/api/v1/modules/sync";
import { GET as listAccessModules } from "../../src/pages/api/v1/access/modules";
import { listModules } from "../../src/modules";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string; tenantUserId: string };

async function bootstrap(): Promise<Bootstrap> {
  const loginIdentifier = `acme-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
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

suite("module catalog API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("GET /api/v1/modules lists every registered module, unsynced modules have a null lastSyncedAt", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { modules: { moduleKey: string; lastSyncedAt: string | null }[] };
    }>(listModulesRoute, {
      method: "GET",
      path: "/api/v1/modules",
      headers: authHeaders(owner)
    });

    expect(result.status).toBe(200);
    expect(result.body.data.modules).toHaveLength(listModules().length);
    expect(
      result.body.data.modules.find((m) => m.moduleKey === "module_management")
        ?.lastSyncedAt
    ).toBeNull();
  });

  test("GET /api/v1/modules/{moduleKey} returns detail for a known module", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { moduleKey: string; type: string; isCore: boolean };
    }>(getModuleDetail, {
      method: "GET",
      path: "/api/v1/modules/module_management",
      headers: authHeaders(owner),
      params: { moduleKey: "module_management" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.moduleKey).toBe("module_management");
    expect(result.body.data.type).toBe("system");
    expect(result.body.data.isCore).toBe(true);
  });

  test("GET /api/v1/modules/{moduleKey} returns a safe 404 for an unknown module", async () => {
    const owner = await bootstrap();

    const result = await invoke(getModuleDetail, {
      method: "GET",
      path: "/api/v1/modules/does_not_exist",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" }
    });

    expect(result.status).toBe(404);
  });

  test("POST /api/v1/modules/sync populates the registry, reports created modules, and audits the action", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { created: string[]; updated: string[]; orphaned: string[] };
    }>(syncModulesRoute, {
      method: "POST",
      path: "/api/v1/modules/sync",
      headers: authHeaders(owner)
    });

    expect(result.status).toBe(200);
    expect(result.body.data.created.sort()).toEqual(
      [...listModules()].map((m) => m.key).sort()
    );

    const detail = await invoke<{ data: { lastSyncedAt: string | null } }>(
      getModuleDetail,
      {
        method: "GET",
        path: "/api/v1/modules/module_management",
        headers: authHeaders(owner),
        params: { moduleKey: "module_management" }
      }
    );
    expect(detail.body.data.lastSyncedAt).not.toBeNull();

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action, resource_type, attributes
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'modules_synced'
    `) as {
      action: string;
      resource_type: string;
      attributes: { created: string[] };
    }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.resource_type).toBe("module_registry");
    expect(auditRows[0]!.attributes.created.length).toBe(listModules().length);
  });

  test("running sync twice reports the second run as fully unchanged", async () => {
    const owner = await bootstrap();

    await invoke(syncModulesRoute, {
      method: "POST",
      path: "/api/v1/modules/sync",
      headers: authHeaders(owner)
    });
    const second = await invoke<{ data: { unchanged: string[] } }>(
      syncModulesRoute,
      {
        method: "POST",
        path: "/api/v1/modules/sync",
        headers: authHeaders(owner)
      }
    );

    expect(second.body.data.unchanged.sort()).toEqual(
      [...listModules()].map((m) => m.key).sort()
    );
  });

  test("ABAC: a user with no module_management.* permissions is denied on list/detail/sync", async () => {
    const owner = await bootstrap();
    const noPermission = await provisionNoPermissionUser(owner.tenantId);
    const headers = {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": owner.tenantId,
      authorization: `Bearer ${noPermission.token}`
    };

    const list = await invoke(listModulesRoute, {
      method: "GET",
      path: "/api/v1/modules",
      headers
    });
    expect(list.status).toBe(403);

    const detail = await invoke(getModuleDetail, {
      method: "GET",
      path: "/api/v1/modules/module_management",
      headers,
      params: { moduleKey: "module_management" }
    });
    expect(detail.status).toBe(403);

    const sync = await invoke(syncModulesRoute, {
      method: "POST",
      path: "/api/v1/modules/sync",
      headers
    });
    expect(sync.status).toBe(403);
  });

  test("GET /api/v1/access/modules (permission catalog) is unaffected by this issue", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { modules: { moduleKey: string; activityCode: string }[] };
    }>(listAccessModules, {
      method: "GET",
      path: "/api/v1/access/modules",
      headers: authHeaders(owner)
    });

    expect(result.status).toBe(200);
    expect(
      result.body.data.modules.some((m) => m.moduleKey === "module_management")
    ).toBe(true);
  });
});
