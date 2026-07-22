/**
 * `POST /api/v1/auth/login` must accept the tenant's `tenant_code` slug in the
 * `x-awcms-mini-tenant-id` header, not only its UUID.
 *
 * The demo login page (`src/pages/login.astro`) asks a human to type a tenant
 * identifier, so what actually arrives is the slug ("default", "ahliweb"),
 * never the UUID. Before the fix the handler passed that slug straight into
 * `withTenant(...)` → `assertUuid(...)`, which threw `Expected a UUID, received:
 * default` for every real login and surfaced in production as a stream of
 * `auth.login.audit_write_failed` warnings (the out-of-band audit path threw on
 * the same bad value a second time). These tests pin the resolved-slug path so
 * it cannot silently regress back to UUID-only.
 *
 * The UUID path itself is exercised by every other login test (they all pass a
 * UUID header), so it is only re-checked once here for symmetry.
 *
 * Skipped entirely unless DATABASE_URL is set — see tests/integration/harness.ts.
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
import { resetRateLimitStoreForTests } from "../../src/lib/security/rate-limit";

const TENANT_CODE = "acme";
const OWNER_LOGIN = "tenant-code-owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const SOURCE_IP = "203.0.113.77";
const USER_AGENT = "AWCMS-Mini-Integration/1.0";

async function bootstrapTenant(): Promise<{ tenantId: string }> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme Corp",
      tenantCode: TENANT_CODE,
      officeCode: "hq",
      officeName: "Head Office",
      ownerLoginIdentifier: OWNER_LOGIN,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  return { tenantId: setup.body.data.tenantId };
}

async function login(tenantHeader: string): Promise<number> {
  const response = await invoke(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantHeader,
      "x-forwarded-for": SOURCE_IP,
      "user-agent": USER_AGENT
    },
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar(),
    locals: { correlationId: "corr-login-tenant-code" }
  });

  return response.status;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("login accepts a tenant_code slug in the tenant header", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetRateLimitStoreForTests();
  });

  test("a valid tenant_code slug authenticates the tenant owner", async () => {
    await bootstrapTenant();

    // The bug: this exact call answered 500 (assertUuid threw) before the fix.
    expect(await login(TENANT_CODE)).toBe(200);
  });

  test("the resolved UUID still authenticates (existing contract unchanged)", async () => {
    const { tenantId } = await bootstrapTenant();

    expect(await login(tenantId)).toBe(200);
  });

  test("an unknown slug is denied 403, never a 500", async () => {
    await bootstrapTenant();

    // A non-UUID header that matches no tenant_code must be rejected the same
    // way an unknown/inactive tenant already is — not crash on assertUuid.
    expect(await login("no-such-tenant")).toBe(403);
  });
});
