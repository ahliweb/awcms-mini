/**
 * Integration tests for tenant module settings (Issue #516, epic #510)
 * against a real PostgreSQL: effective settings merge, shallow PATCH merge
 * semantics, secret-shaped key rejection, audit diff metadata, and RLS
 * isolation.
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
import {
  GET as getModuleSettings,
  PATCH as patchModuleSettings
} from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";

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

suite("tenant module settings API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("GET returns a defaults-only effective view before any override exists", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: {
        moduleKey: string;
        tenantOverride: Record<string, unknown>;
        effective: Record<string, unknown>;
        updatedAt: string | null;
      };
    }>(getModuleSettings, {
      method: "GET",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.moduleKey).toBe("form_drafts");
    expect(result.body.data.tenantOverride).toEqual({});
    expect(result.body.data.updatedAt).toBeNull();
  });

  test("GET/PATCH an unknown module key is a 404", async () => {
    const owner = await bootstrap();

    const getResult = await invoke(getModuleSettings, {
      method: "GET",
      path: "/api/v1/tenant/modules/does_not_exist/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" }
    });
    expect(getResult.status).toBe(404);

    const patchResult = await invoke(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/does_not_exist/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" },
      body: { a: 1 }
    });
    expect(patchResult.status).toBe(404);
  });

  test("PATCH rejects a secret-shaped key (400 SETTINGS_SENSITIVE_KEY_REJECTED)", async () => {
    const owner = await bootstrap();

    const result = await invoke(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { apiToken: "sk-123" }
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "SETTINGS_SENSITIVE_KEY_REJECTED"
    );

    const admin = getAdminSql();
    const rows = await admin`
      SELECT count(*)::int AS count FROM awcms_mini_module_settings
      WHERE tenant_id = ${owner.tenantId} AND module_key = 'form_drafts'
    `;
    expect((rows[0] as { count: number }).count).toBe(0);
  });

  test("PATCH rejects a secret-shaped VALUE under an innocently-named key (400 SETTINGS_SECRET_SHAPED_VALUE_REJECTED)", async () => {
    const owner = await bootstrap();

    const result = await invoke(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      // `publicLabel` isn't a secret-shaped key name, but the value pasted
      // into it is a raw Bearer token — the value-shape check must still
      // reject it (key-name checking alone would let this through).
      body: { publicLabel: "Bearer sk-live-abc123xyz" }
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "SETTINGS_SECRET_SHAPED_VALUE_REJECTED"
    );

    const admin = getAdminSql();
    const rows = await admin`
      SELECT count(*)::int AS count FROM awcms_mini_module_settings
      WHERE tenant_id = ${owner.tenantId} AND module_key = 'form_drafts'
    `;
    expect((rows[0] as { count: number }).count).toBe(0);
  });

  test("PATCH is a shallow merge — a later PATCH does not wipe keys the caller didn't mention", async () => {
    const owner = await bootstrap();

    const first = await invoke<{
      data: { tenantOverride: Record<string, unknown> };
    }>(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { retentionDays: 30, autoExpire: true }
    });
    expect(first.status).toBe(200);
    expect(first.body.data.tenantOverride).toEqual({
      retentionDays: 30,
      autoExpire: true
    });

    const second = await invoke<{
      data: { tenantOverride: Record<string, unknown> };
    }>(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { retentionDays: 45 }
    });

    expect(second.status).toBe(200);
    expect(second.body.data.tenantOverride).toEqual({
      retentionDays: 45,
      autoExpire: true
    });
  });

  test("PATCH is audited with safe diff metadata (key names only)", async () => {
    const owner = await bootstrap();

    await invoke(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { retentionDays: 30 }
    });

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action, resource_type, resource_id, attributes
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'settings_updated'
    `) as {
      action: string;
      resource_type: string;
      resource_id: string;
      attributes: { diff: { addedKeys: string[] } };
    }[];

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.resource_id).toBe("form_drafts");
    expect(auditRows[0]!.attributes.diff.addedKeys).toEqual(["retentionDays"]);
  });

  test("RLS: a settings override for tenant A never appears for tenant B", async () => {
    const ownerA = await bootstrap("tenant-a", "Tenant A");
    const admin = getAdminSql();
    const tenantBId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await admin`
      INSERT INTO awcms_mini_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${tenantBId}, 'tenant-b-settings', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
    `;

    await invoke(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(ownerA),
      params: { moduleKey: "form_drafts" },
      body: { retentionDays: 30 }
    });

    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_module_settings
      WHERE tenant_id = ${tenantBId}
    `) as { count: number }[];
    expect(rows[0]?.count).toBe(0);
  });
});
