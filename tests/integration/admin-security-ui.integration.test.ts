/**
 * Integration tests for the `/admin/security` admin UI's own testing
 * checklist (Issue #592, epic: full-online auth hardening #587-#593).
 *
 * This page is not rendered through a browser/SSR harness for the two
 * ABAC/audit checks below (see `tests/integration/tenant-domain-admin.integration.test.ts`'s
 * own docblock for why — this repo has no such harness for `/admin/*`
 * pages other than the Playwright specs under `tests/e2e/*.e2e.ts`, which
 * cover the two rendering states this issue's testing checklist calls out
 * separately: `tests/e2e/admin-security-disabled.e2e.ts` and
 * `tests/e2e/admin-security-enabled.e2e.ts`). Instead this file exercises
 * the real route handlers the page's mutation forms call
 * (`PATCH /api/v1/identity/sso/policy`,
 * `POST`/`DELETE /api/v1/identity/sso/providers[/{id}]`) against a real
 * PostgreSQL, for the two checklist items Issue #591's own
 * `tenant-sso-flow.integration.test.ts` did not already cover:
 *
 * 1. "Integration test: policy update requires permission" — #591's own
 *    suite covers ABAC default-deny for `GET /identity/sso/providers`
 *    ("ABAC: an identity with no role/permission is denied admin provider
 *    access") but never exercises `PATCH /identity/sso/policy` itself
 *    without the `sso_policy.update` permission specifically.
 * 2. "Audit test for policy changes" — #591's endpoints already call
 *    `recordAuditEvent` for `sso_policy_updated`/`sso_provider_created`/
 *    `sso_provider_deleted` (see those route files' own comments) but no
 *    test asserted a matching row actually lands in
 *    `awcms_mini_audit_events`, the same gap
 *    `tenant-domain-api.integration.test.ts`'s own audit assertions close
 *    for that module.
 *
 * "sso_required blocked without break-glass" is exhaustively covered by
 * #591's own suite (`tenant-sso-flow.integration.test.ts`'s two
 * "break-glass enforcement..." tests) — not repeated here.
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
import { POST as createProvider } from "../../src/pages/api/v1/identity/sso/providers/index";
import { DELETE as deleteProvider } from "../../src/pages/api/v1/identity/sso/providers/[id]";
import { resetDatabaseCircuitBreakerForTests } from "../../src/lib/database/circuit-breaker";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const NOROLE_LOGIN = "norole@example.com";
const NOROLE_PASSWORD = "integration-test-norole-password";

type Bootstrap = { tenantId: string; token: string };

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

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

/** Creates a second identity in the same tenant with a `tenant_users` membership but zero role assignments — the same "default deny" fixture shape `tenant-sso-flow.integration.test.ts`'s own ABAC test uses. */
async function bootstrapNoRoleUser(tenantId: string): Promise<Bootstrap> {
  const admin = getAdminSql();

  const profileRows = await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'No Role User') RETURNING id
  `;
  const passwordHash = await Bun.password.hash(NOROLE_PASSWORD);
  await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${(profileRows[0] as { id: string }).id}, ${NOROLE_LOGIN}, ${passwordHash})
  `;
  const identityRows = await admin`
    SELECT id FROM awcms_mini_identities WHERE login_identifier = ${NOROLE_LOGIN}
  `;
  await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${(identityRows[0] as { id: string }).id})
  `;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier: NOROLE_LOGIN, password: NOROLE_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token };
}

function authHeaders(actor: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": actor.tenantId,
    authorization: `Bearer ${actor.token}`
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Admin security UI (Issue #592) — ABAC + audit", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetDatabaseCircuitBreakerForTests();
    process.env.AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(
      32,
      4
    ).toString("base64");
  });

  test("PATCH /identity/sso/policy without sso_policy.update permission is denied (default deny), and the policy is unchanged", async () => {
    const owner = await bootstrapTenant();
    const norole = await bootstrapNoRoleUser(owner.tenantId);

    const result = await invoke<{ error: { code: string } }>(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(norole),
      body: { ssoEnabled: true }
    });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("ACCESS_DENIED");

    const unchanged = await invoke<{ data: { ssoEnabled: boolean } }>(
      getPolicy,
      {
        method: "GET",
        path: "/api/v1/identity/sso/policy",
        headers: authHeaders(owner)
      }
    );
    expect(unchanged.body.data.ssoEnabled).toBe(false);
  });

  test("a successful PATCH /identity/sso/policy writes an sso_policy_updated audit event for the actor", async () => {
    const owner = await bootstrapTenant();

    const result = await invoke(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { ssoEnabled: true, autoLinkVerifiedEmail: true }
    });
    expect(result.status).toBe(200);

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action, resource_type, resource_id, actor_tenant_user_id, severity
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'sso_policy_updated'
    `) as {
      action: string;
      resource_type: string;
      resource_id: string;
      actor_tenant_user_id: string | null;
      severity: string;
    }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.resource_type).toBe("tenant_auth_policy");
    expect(auditRows[0]!.resource_id).toBe(owner.tenantId);
    expect(auditRows[0]!.actor_tenant_user_id).not.toBeNull();
    expect(auditRows[0]!.severity).toBe("warning");
  });

  test("a rejected break-glass PATCH (409) does NOT write an sso_policy_updated audit event", async () => {
    const owner = await bootstrapTenant();

    const result = await invoke<{ error: { code: string } }>(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { ssoEnabled: true, ssoRequired: true }
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("BREAK_GLASS_REQUIRED");

    const admin = getAdminSql();
    const auditRows = await admin`
      SELECT id FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'sso_policy_updated'
    `;
    expect(auditRows).toHaveLength(0);
  });

  test("SSO provider create then delete each write their own audit event", async () => {
    const owner = await bootstrapTenant();

    const created = await invoke<{ data: { id: string } }>(createProvider, {
      method: "POST",
      path: "/api/v1/identity/sso/providers",
      headers: authHeaders(owner),
      body: {
        providerKey: "okta",
        displayName: "Okta",
        issuerUrl: "https://acme.okta.example.com",
        clientId: "test-okta-client-id",
        clientSecretEnvVar: "OKTA_TEST_CLIENT_SECRET",
        enabled: true
      }
    });
    expect(created.status).toBe(200);
    const providerId = created.body.data.id;

    const deleted = await invoke(deleteProvider, {
      method: "DELETE",
      path: `/api/v1/identity/sso/providers/${providerId}`,
      params: { id: providerId },
      headers: authHeaders(owner),
      body: { reason: "rotating away from Okta in this test" }
    });
    expect(deleted.status).toBe(200);

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action, resource_id
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId}
        AND action IN ('sso_provider_created', 'sso_provider_deleted')
      ORDER BY created_at ASC
    `) as { action: string; resource_id: string }[];

    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toEqual({
      action: "sso_provider_created",
      resource_id: providerId
    });
    expect(auditRows[1]).toEqual({
      action: "sso_provider_deleted",
      resource_id: providerId
    });
  });
});
