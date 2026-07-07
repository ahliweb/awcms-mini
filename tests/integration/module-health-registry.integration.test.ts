/**
 * Integration tests for module health/readiness (Issue #520, epic #510)
 * against a real PostgreSQL: fresh-install "degraded" state (before any
 * descriptor sync has run), "healthy" after syncing, the explicit
 * `POST .../health/check` provider signal, and 404/safe-failure behavior.
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
import { POST as syncModules } from "../../src/pages/api/v1/modules/sync";
import { GET as getModuleHealth } from "../../src/pages/api/v1/modules/[moduleKey]/health";
import { POST as postHealthCheck } from "../../src/pages/api/v1/modules/[moduleKey]/health/check";

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

type HealthBody = {
  data: {
    moduleKey: string;
    status: string;
    signals: { name: string; status: string; detail?: string }[];
  };
};

function findSignal(body: HealthBody, name: string) {
  return body.data.signals.find((s) => s.name === name);
}

const suite = integrationEnabled ? describe : describe.skip;

suite("module health/readiness API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("before any descriptor sync, db_registry_synced fails and overall status is degraded", async () => {
    const owner = await bootstrap();

    const result = await invoke<HealthBody>(getModuleHealth, {
      method: "GET",
      path: "/api/v1/modules/module_management/health",
      headers: authHeaders(owner),
      params: { moduleKey: "module_management" }
    });

    expect(result.status).toBe(200);
    expect(findSignal(result.body, "db_registry_synced")?.status).toBe("fail");
    expect(result.body.data.status).toBe("degraded");
  });

  test("after syncing, module_management's own health is fully healthy", async () => {
    const owner = await bootstrap();

    const syncResult = await invoke(syncModules, {
      method: "POST",
      path: "/api/v1/modules/sync",
      headers: authHeaders(owner)
    });
    expect(syncResult.status).toBe(200);

    const result = await invoke<HealthBody>(getModuleHealth, {
      method: "GET",
      path: "/api/v1/modules/module_management/health",
      headers: authHeaders(owner),
      params: { moduleKey: "module_management" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.status).toBe("healthy");
    for (const signal of result.body.data.signals) {
      expect(["pass", "not_applicable"]).toContain(signal.status);
    }
  });

  test("GET never runs a provider health check (always not_applicable, even for email)", async () => {
    const owner = await bootstrap();

    const result = await invoke<HealthBody>(getModuleHealth, {
      method: "GET",
      path: "/api/v1/modules/email/health",
      headers: authHeaders(owner),
      params: { moduleKey: "email" }
    });

    expect(result.status).toBe(200);
    expect(findSignal(result.body, "provider_health_check")).toBeUndefined();
  });

  test("POST .../health/check runs the live provider check for email", async () => {
    const owner = await bootstrap();

    const result = await invoke<HealthBody>(postHealthCheck, {
      method: "POST",
      path: "/api/v1/modules/email/health/check",
      headers: authHeaders(owner),
      params: { moduleKey: "email" }
    });

    expect(result.status).toBe(200);
    const providerSignal = findSignal(result.body, "provider_health_check");
    expect(providerSignal).toBeDefined();
    expect(providerSignal?.status).not.toBe("not_applicable");
    // Safe failure: EMAIL_PROVIDER is unset in the test environment, so this
    // fails deterministically — but never leaks the raw misconfiguration
    // reason, only the fixed generic detail.
    expect(providerSignal?.detail).toBe("Email provider health check failed.");

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action, resource_id, severity FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'health_checked'
    `) as { action: string; resource_id: string; severity: string }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.resource_id).toBe("email");
  });

  test("POST .../health/check records a row in awcms_mini_module_health_checks (instance-level history, RLS-free)", async () => {
    const owner = await bootstrap();

    await invoke(postHealthCheck, {
      method: "POST",
      path: "/api/v1/modules/email/health/check",
      headers: authHeaders(owner),
      params: { moduleKey: "email" }
    });

    const admin = getAdminSql();
    const historyRows = (await admin`
      SELECT status, message FROM awcms_mini_module_health_checks
      WHERE module_key = 'email'
    `) as { status: string; message: string | null }[];

    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]!.status).toBe("degraded");
    expect(historyRows[0]!.message).toBe(
      "Failed signals: provider_health_check."
    );
  });

  test("GET .../health never writes to awcms_mini_module_health_checks (passive read only)", async () => {
    const owner = await bootstrap();

    await invoke(getModuleHealth, {
      method: "GET",
      path: "/api/v1/modules/email/health",
      headers: authHeaders(owner),
      params: { moduleKey: "email" }
    });

    const admin = getAdminSql();
    const historyRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_module_health_checks
    `) as { count: number }[];

    expect(historyRows[0]?.count).toBe(0);
  });

  test("POST .../health/check is not_applicable for a module with no provider (e.g. logging)", async () => {
    const owner = await bootstrap();

    const result = await invoke<HealthBody>(postHealthCheck, {
      method: "POST",
      path: "/api/v1/modules/logging/health/check",
      headers: authHeaders(owner),
      params: { moduleKey: "logging" }
    });

    expect(result.status).toBe(200);
    expect(findSignal(result.body, "provider_health_check")?.status).toBe(
      "not_applicable"
    );
  });

  test("an unknown module key is a 404 for both GET and POST", async () => {
    const owner = await bootstrap();

    const getResult = await invoke(getModuleHealth, {
      method: "GET",
      path: "/api/v1/modules/does_not_exist/health",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" }
    });
    expect(getResult.status).toBe(404);

    const postResult = await invoke(postHealthCheck, {
      method: "POST",
      path: "/api/v1/modules/does_not_exist/health/check",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" }
    });
    expect(postResult.status).toBe(404);
  });

  test("the response body never contains a raw DATABASE_URL or connection string", async () => {
    const owner = await bootstrap();

    const result = await invoke<HealthBody>(getModuleHealth, {
      method: "GET",
      path: "/api/v1/modules/module_management/health",
      headers: authHeaders(owner),
      params: { moduleKey: "module_management" }
    });

    const raw = JSON.stringify(result.body);
    expect(raw).not.toContain("postgres://");
    expect(raw).not.toContain(process.env.DATABASE_URL ?? "__unset__");
  });
});
