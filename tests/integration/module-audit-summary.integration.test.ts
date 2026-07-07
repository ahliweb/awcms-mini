/**
 * Integration tests for the module admin detail page's lifecycle/audit
 * summary (Issue #521, epic #510) against a real PostgreSQL —
 * `fetchModuleAuditSummary` reads the same `awcms_mini_audit_events` rows
 * the tenant-module-lifecycle (#515), settings (#516), and health-check
 * (#520) endpoints already write, scoped to one target module and one
 * tenant.
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
import { POST as disableModule } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/disable";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { fetchModuleAuditSummary } from "../../src/modules/module-management/application/module-audit-summary";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";

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

suite("module audit summary", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("returns disable and settings-update events for the target module, newest first", async () => {
    const owner = await bootstrap();

    await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/form_drafts/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { reason: "Not used." }
    });

    await invoke(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/form_drafts/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { retentionDays: 30 }
    });

    const summary = await withTenant(
      getDatabaseClient(),
      owner.tenantId,
      (tx) => fetchModuleAuditSummary(tx, owner.tenantId, "form_drafts")
    );

    expect(summary.map((entry) => entry.action)).toEqual([
      "settings_updated",
      "tenant_module_disabled"
    ]);
  });

  test("never returns events for a different module", async () => {
    const owner = await bootstrap();

    await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/form_drafts/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "form_drafts" },
      body: { reason: "Not used." }
    });

    const summary = await withTenant(
      getDatabaseClient(),
      owner.tenantId,
      (tx) => fetchModuleAuditSummary(tx, owner.tenantId, "email")
    );

    expect(summary).toEqual([]);
  });

  test("RLS: never returns another tenant's audit events", async () => {
    const ownerA = await bootstrap();
    const admin = getAdminSql();
    const tenantBId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await admin`
      INSERT INTO awcms_mini_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${tenantBId}, 'tenant-b-audit', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
    `;

    await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/form_drafts/disable",
      headers: authHeaders(ownerA),
      params: { moduleKey: "form_drafts" },
      body: { reason: "Tenant A only." }
    });

    const summary = await withTenant(getDatabaseClient(), tenantBId, (tx) =>
      fetchModuleAuditSummary(tx, tenantBId, "form_drafts")
    );

    expect(summary).toEqual([]);
  });
});
