/**
 * Integration tests for the module job registry endpoint (Issue #519, epic
 * #510) against a real PostgreSQL — the endpoint itself has zero I/O
 * beyond the auth guard (`fetchModuleJobs` reads `listModules()` directly),
 * so this mostly exercises the guard/404 wiring; the actual job data is
 * already exhaustively covered by `tests/module-management-job-registry.test.ts`.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { GET as getModuleJobs } from "../../src/pages/api/v1/modules/[moduleKey]/jobs";

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

suite("module job registry API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("returns the declared jobs for a module that has some", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { moduleKey: string; jobs: { command: string }[] };
    }>(getModuleJobs, {
      method: "GET",
      path: "/api/v1/modules/logging/jobs",
      headers: authHeaders(owner),
      params: { moduleKey: "logging" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.moduleKey).toBe("logging");
    expect(result.body.data.jobs).toEqual([
      expect.objectContaining({ command: "bun run logs:audit:purge" })
    ]);
  });

  test("returns an empty list for a registered module with no jobs", async () => {
    // Issue #746 gave `identity_access` its own first job
    // (`identity-access:business-scope:expiry`) — `tenant_admin` is the
    // representative "no jobs" example instead (see
    // `tests/module-management-job-registry.test.ts`'s own comment for why
    // `profile_identity` was deliberately NOT chosen: sibling epic #748 is
    // actively adding surface to it and could give it a job first).
    const owner = await bootstrap();

    const result = await invoke<{ data: { jobs: unknown[] } }>(getModuleJobs, {
      method: "GET",
      path: "/api/v1/modules/tenant_admin/jobs",
      headers: authHeaders(owner),
      params: { moduleKey: "tenant_admin" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.jobs).toEqual([]);
  });

  test("an unknown module key is a 404", async () => {
    const owner = await bootstrap();

    const result = await invoke(getModuleJobs, {
      method: "GET",
      path: "/api/v1/modules/does_not_exist/jobs",
      headers: authHeaders(owner),
      params: { moduleKey: "does_not_exist" }
    });

    expect(result.status).toBe(404);
  });
});
