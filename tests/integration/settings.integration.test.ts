/**
 * Integration tests for the admin Settings endpoint (PR: Settings). Exercises
 * the real handlers against a real PostgreSQL via the shared harness — read,
 * partial update across both awcms_mini_tenants (RLS-free) and
 * awcms_mini_tenant_settings (RLS tenant-scoped), validation, and default-deny.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase,
  createCookieJar
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as getSettings,
  PATCH as updateSettings
} from "../../src/pages/api/v1/settings/index";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: OWNER_LOGIN,
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
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Settings API (real Postgres)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("reads the tenant's default settings after setup", async () => {
    const b = await bootstrap();

    const res = await invoke<{
      data: {
        tenantId: string;
        tenantName: string;
        legalName: string | null;
        defaultLocale: string;
        defaultTheme: string;
        timezone: string;
        featureFlags: Record<string, unknown>;
      };
    }>(getSettings, {
      method: "GET",
      path: "/api/v1/settings",
      headers: authHeaders(b)
    });

    expect(res.status).toBe(200);
    expect(res.body.data.tenantName).toBe("Acme");
    expect(res.body.data.legalName).toBeNull();
    expect(res.body.data.defaultLocale).toBe("id");
    expect(res.body.data.defaultTheme).toBe("system");
    expect(res.body.data.timezone).toBe("Asia/Jakarta");
    expect(res.body.data.featureFlags).toEqual({});
  });

  test("updates a subset of fields across both tables and persists them", async () => {
    const b = await bootstrap();

    const updated = await invoke<{
      data: {
        tenantName: string;
        legalName: string | null;
        defaultTheme: string;
        timezone: string;
        featureFlags: Record<string, unknown>;
      };
    }>(updateSettings, {
      method: "PATCH",
      path: "/api/v1/settings",
      headers: authHeaders(b),
      body: {
        tenantName: "Acme Retail Group",
        legalName: "PT Acme Retail Indonesia",
        defaultTheme: "dark",
        timezone: "Asia/Makassar",
        featureFlags: { betaReports: true }
      }
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.tenantName).toBe("Acme Retail Group");
    expect(updated.body.data.legalName).toBe("PT Acme Retail Indonesia");
    expect(updated.body.data.defaultTheme).toBe("dark");
    expect(updated.body.data.timezone).toBe("Asia/Makassar");
    expect(updated.body.data.featureFlags).toEqual({ betaReports: true });

    // Re-reading confirms it actually persisted (not just echoed back).
    const reread = await invoke<{
      data: { tenantName: string; timezone: string };
    }>(getSettings, {
      method: "GET",
      path: "/api/v1/settings",
      headers: authHeaders(b)
    });
    expect(reread.body.data.tenantName).toBe("Acme Retail Group");
    expect(reread.body.data.timezone).toBe("Asia/Makassar");
  });

  test("rejects an invalid defaultLocale and an empty body", async () => {
    const b = await bootstrap();

    const invalidLocale = await invoke<{ error: { code: string } }>(
      updateSettings,
      {
        method: "PATCH",
        path: "/api/v1/settings",
        headers: authHeaders(b),
        body: { defaultLocale: "fr" }
      }
    );
    expect(invalidLocale.status).toBe(400);

    const emptyBody = await invoke<{ error: { code: string } }>(
      updateSettings,
      {
        method: "PATCH",
        path: "/api/v1/settings",
        headers: authHeaders(b),
        body: {}
      }
    );
    expect(emptyBody.status).toBe(400);
  });

  test("a settings update by tenant A never affects tenant B (RLS-free tenants table stays scoped by WHERE id)", async () => {
    const a = await bootstrap();

    const tenantBId = crypto.randomUUID();
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
      VALUES (${tenantBId}, 'beta', 'Beta Original Name')
    `;

    await invoke(updateSettings, {
      method: "PATCH",
      path: "/api/v1/settings",
      headers: authHeaders(a),
      body: { tenantName: "Acme Renamed" }
    });

    const betaRow = (await admin`
      SELECT tenant_name FROM awcms_mini_tenants WHERE id = ${tenantBId}
    `) as { tenant_name: string }[];
    expect(betaRow[0]!.tenant_name).toBe("Beta Original Name");
  });

  test("default-deny: a role-less user cannot read or update settings", async () => {
    const b = await bootstrap();

    const sql = getAdminSql();
    const passwordHash = await Bun.password.hash("norole-password-123456");
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
      const profile = (await tx`
        INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
        VALUES (${b.tenantId}, 'person', 'No Role') RETURNING id
      `) as { id: string }[];
      const identity = (await tx`
        INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${b.tenantId}, ${profile[0]!.id}, 'norole-settings@example.com', ${passwordHash})
        RETURNING id
      `) as { id: string }[];
      await tx`
        INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
        VALUES (${b.tenantId}, ${identity[0]!.id})
      `;
    });

    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId
      },
      body: {
        loginIdentifier: "norole-settings@example.com",
        password: "norole-password-123456"
      },
      cookies: createCookieJar()
    });
    expect(login.status).toBe(200);
    const headers = {
      "x-awcms-mini-tenant-id": b.tenantId,
      authorization: `Bearer ${login.body.data.token}`
    };

    const read = await invoke<{ error: { code: string } }>(getSettings, {
      method: "GET",
      path: "/api/v1/settings",
      headers
    });
    expect(read.status).toBe(403);

    const update = await invoke<{ error: { code: string } }>(updateSettings, {
      method: "PATCH",
      path: "/api/v1/settings",
      headers: { ...headers, "content-type": "application/json" },
      body: { tenantName: "Hacked" }
    });
    expect(update.status).toBe(403);
  });
});
