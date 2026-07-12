/**
 * Integration tests for the authorized dependency-health endpoint (Issue
 * #698, epic #679 "operational proof" wave) against a real PostgreSQL —
 * `GET /api/v1/logs/observability/dependency-health`. Covers the
 * acceptance criterion "authorized health/readiness output that
 * distinguishes local dependencies from optional online providers".
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

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
import { GET as getDependencyHealth } from "../../src/pages/api/v1/logs/observability/dependency-health";
import {
  getProviderCircuitBreaker,
  resetDatabaseCircuitBreakerForTests,
  resetProviderCircuitBreakersForTests
} from "../../src/lib/database/circuit-breaker";

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

suite("GET /api/v1/logs/observability/dependency-health", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetDatabaseCircuitBreakerForTests();
    resetProviderCircuitBreakersForTests();
  });

  afterEach(() => {
    resetDatabaseCircuitBreakerForTests();
    resetProviderCircuitBreakersForTests();
  });

  test("requires a tenant header", async () => {
    const response = await invoke(getDependencyHealth, {
      method: "GET",
      path: "/api/v1/logs/observability/dependency-health",
      headers: {}
    });

    expect(response.status).toBe(400);
  });

  test("requires authentication", async () => {
    const owner = await bootstrap();

    const response = await invoke(getDependencyHealth, {
      method: "GET",
      path: "/api/v1/logs/observability/dependency-health",
      headers: { "x-awcms-mini-tenant-id": owner.tenantId }
    });

    expect(response.status).toBe(401);
  });

  test("owner sees a healthy, closed-circuit local database dependency with all 5 work classes", async () => {
    const owner = await bootstrap();

    const response = await invoke<{
      data: {
        localDependencies: Array<{
          name: string;
          status: string;
          circuitBreakerState: string;
          workClasses: Array<{ workClass: string }>;
        }>;
        optionalProviders: Array<{
          family: string;
          circuitBreakerState: string;
        }>;
      };
    }>(getDependencyHealth, {
      method: "GET",
      path: "/api/v1/logs/observability/dependency-health",
      headers: authHeaders(owner)
    });

    expect(response.status).toBe(200);
    expect(response.body.data.localDependencies).toHaveLength(1);
    expect(response.body.data.localDependencies[0]?.name).toBe("database");
    expect(response.body.data.localDependencies[0]?.status).toBe("healthy");
    expect(response.body.data.localDependencies[0]?.circuitBreakerState).toBe(
      "closed"
    );
    expect(
      response.body.data.localDependencies[0]?.workClasses.map(
        (entry) => entry.workClass
      )
    ).toEqual([
      "critical_transaction",
      "interactive",
      "reporting",
      "background_sync",
      "maintenance"
    ]);
  });

  test("reports an open provider circuit under its bounded family label, never the raw tenant-scoped registry key", async () => {
    const owner = await bootstrap();

    // Simulate a tenant-scoped SSO provider breaker (Issue #610 key shape:
    // "<category>:<tenantId>:<providerKey>") tripping open — the endpoint
    // must report only the bounded family prefix, never this raw key.
    const rawKey = `sso-oidc-discovery:${owner.tenantId}:okta`;
    const breaker = getProviderCircuitBreaker(rawKey);
    const now = new Date();

    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(now);
    }

    expect(breaker.canAttempt(now)).toBe(false);

    const response = await invoke<{
      data: {
        optionalProviders: Array<{
          family: string;
          circuitBreakerState: string;
        }>;
      };
    }>(getDependencyHealth, {
      method: "GET",
      path: "/api/v1/logs/observability/dependency-health",
      headers: authHeaders(owner)
    });

    expect(response.status).toBe(200);
    const family = response.body.data.optionalProviders.find(
      (entry) => entry.family === "sso-oidc-discovery"
    );

    expect(family).toBeDefined();
    expect(family?.circuitBreakerState).toBe("open");
    // The raw key (with the tenant id embedded) must never appear anywhere
    // in the response body.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(owner.tenantId);
    expect(serialized).not.toContain(rawKey);
  });
});
