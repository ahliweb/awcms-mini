/**
 * Integration tests for module permission sync/status (Issue #517, epic
 * #510) against a real PostgreSQL: `module_management` itself declares
 * permissions in code (`module.ts`) matching migration 025's seed exactly,
 * so it is the natural "all synced" fixture; `tenant_admin` declares none,
 * so its real seeded permissions (migration 005) are the natural
 * "all orphaned" fixture — no synthetic data needed for either case.
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
import { GET as getModulePermissions } from "../../src/pages/api/v1/modules/[moduleKey]/permissions";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

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

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function authHeaders(owner: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("module permission sync/status API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("module_management's own permissions are all synced", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: {
        moduleKey: string;
        entries: { status: string }[];
      };
    }>(getModulePermissions, {
      method: "GET",
      path: "/api/v1/modules/module_management/permissions",
      headers: authHeaders(owner),
      params: { moduleKey: "module_management" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.moduleKey).toBe("module_management");
    expect(result.body.data.entries.length).toBeGreaterThan(0);
    expect(
      result.body.data.entries.every((entry) => entry.status === "synced")
    ).toBe(true);
  });

  test("a module with no declared descriptor permissions reports its real catalog rows as orphaned", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { entries: { status: string; activityCode: string }[] };
    }>(getModulePermissions, {
      method: "GET",
      path: "/api/v1/modules/tenant_admin/permissions",
      headers: authHeaders(owner),
      params: { moduleKey: "tenant_admin" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.entries.length).toBeGreaterThan(0);
    expect(
      result.body.data.entries.every((entry) => entry.status === "orphaned")
    ).toBe(true);
  });

  test("an entirely unknown module key is a 404", async () => {
    const owner = await bootstrap();

    const result = await invoke(getModulePermissions, {
      method: "GET",
      path: "/api/v1/modules/does_not_exist/permissions",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" }
    });

    expect(result.status).toBe(404);
  });

  test("does not mutate awcms_mini_permissions (read-only)", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    const before = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_permissions
    `) as { count: number }[];

    await invoke(getModulePermissions, {
      method: "GET",
      path: "/api/v1/modules/tenant_admin/permissions",
      headers: authHeaders(owner),
      params: { moduleKey: "tenant_admin" }
    });

    const after = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_permissions
    `) as { count: number }[];

    expect(after[0]?.count).toBe(before[0]?.count);
  });
});
