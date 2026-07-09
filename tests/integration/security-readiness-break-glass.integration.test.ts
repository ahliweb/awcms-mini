/**
 * Integration test for `checkSsoBreakGlassReady` (Issue #593, epic:
 * full-online auth hardening #587-#593).
 *
 * `saveTenantAuthPolicy` (Issue #591) only validates break-glass eligibility
 * at the moment a tenant auth policy is SAVED — a break-glass identity that
 * was eligible then can be deactivated LATER by an unrelated action (e.g. an
 * admin deactivating a user, or removing their tenant membership) without
 * the policy row itself ever being re-saved. That drift cannot be caught by
 * a unit test against pure functions; it needs a real Postgres round trip:
 * save a valid policy through the real endpoint, mutate the break-glass
 * identity's eligibility directly in the database (simulating the
 * unrelated deactivation), then confirm `checkSsoBreakGlassReady` — run
 * fresh, exactly as `bun run security:readiness` would — now reports the
 * gap.
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
  GET as getPolicy,
  PATCH as updatePolicy
} from "../../src/pages/api/v1/identity/sso/policy/index";
import { checkSsoBreakGlassReady } from "../../scripts/security-readiness";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string; ownerIdentityId: string };

async function bootstrapTenant(tenantCode = "acme"): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: `Tenant ${tenantCode}`,
      tenantCode,
      officeCode: "hq",
      officeName: "Head Office",
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

  const admin = getAdminSql();
  const ownerIdentityRows = await admin`
    SELECT id FROM awcms_mini_identities
    WHERE tenant_id = ${setup.body.data.tenantId} AND login_identifier = ${OWNER_LOGIN}
  `;
  const ownerIdentityId = (ownerIdentityRows[0] as { id: string }).id;

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    ownerIdentityId
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

suite("checkSsoBreakGlassReady (Issue #593)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("passes when no tenant has a policy restricting password login", async () => {
    await bootstrapTenant();

    const result = await checkSsoBreakGlassReady();

    expect(result.status).toBe("pass");
    expect(result.severity).toBe("critical");
  });

  test("passes when sso_required=true was saved with a currently-eligible break-glass identity", async () => {
    const owner = await bootstrapTenant();

    const patch = await invoke<{ data: { ssoRequired: boolean } }>(
      updatePolicy,
      {
        method: "PATCH",
        path: "/api/v1/identity/sso/policy",
        headers: authHeaders(owner),
        body: {
          ssoEnabled: true,
          ssoRequired: true,
          breakGlassIdentityIds: [owner.ownerIdentityId]
        }
      }
    );
    expect(patch.status).toBe(200);
    expect(patch.body.data.ssoRequired).toBe(true);

    const result = await checkSsoBreakGlassReady();

    expect(result.status).toBe("pass");
  });

  test("fails when the break-glass identity is deactivated AFTER the policy was saved (residual gap save-time validation cannot catch)", async () => {
    const owner = await bootstrapTenant();

    const patch = await invoke<{ data: { ssoRequired: boolean } }>(
      updatePolicy,
      {
        method: "PATCH",
        path: "/api/v1/identity/sso/policy",
        headers: authHeaders(owner),
        body: {
          ssoEnabled: true,
          ssoRequired: true,
          breakGlassIdentityIds: [owner.ownerIdentityId]
        }
      }
    );
    expect(patch.status).toBe(200);

    // Simulate an unrelated action deactivating the break-glass owner's
    // identity AFTER the policy was already saved — saveTenantAuthPolicy is
    // never re-invoked here, so its own validation cannot see this drift.
    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_identities SET status = 'inactive'
      WHERE id = ${owner.ownerIdentityId}
    `;

    const result = await checkSsoBreakGlassReady();

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain(owner.tenantId);
  });

  test("fails when the break-glass identity's tenant membership is revoked AFTER the policy was saved", async () => {
    const owner = await bootstrapTenant();

    const patch = await invoke(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: {
        ssoEnabled: true,
        passwordLoginEnabled: false,
        breakGlassIdentityIds: [owner.ownerIdentityId]
      }
    });
    expect(patch.status).toBe(200);

    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_tenant_users SET status = 'inactive'
      WHERE tenant_id = ${owner.tenantId} AND identity_id = ${owner.ownerIdentityId}
    `;

    const result = await checkSsoBreakGlassReady();

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain(owner.tenantId);
  });

  test("does not flag a tenant whose policy was rejected at save time (never persisted)", async () => {
    const owner = await bootstrapTenant();

    const rejected = await invoke<{ error: { code: string } }>(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { ssoEnabled: true, ssoRequired: true }
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("BREAK_GLASS_REQUIRED");

    const stillDefault = await invoke<{ data: { ssoRequired: boolean } }>(
      getPolicy,
      {
        method: "GET",
        path: "/api/v1/identity/sso/policy",
        headers: authHeaders(owner)
      }
    );
    expect(stillDefault.body.data.ssoRequired).toBe(false);

    const result = await checkSsoBreakGlassReady();

    expect(result.status).toBe("pass");
  });
});
