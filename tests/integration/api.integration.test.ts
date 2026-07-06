/**
 * HTTP-level integration tests against a real PostgreSQL (recommendation #1).
 *
 * Guards the endpoint wiring the pure-unit suite cannot: real transactions,
 * the setup singleton lock, argon2 login + session issue, the
 * resolveTenantContext -> fetchGrantedPermissionKeys -> evaluateAccess ->
 * recordDecisionLog guard chain (allow AND default-deny), PostgreSQL RLS
 * tenant isolation, and the write -> audit(redaction/jsonb) -> read-back path
 * that has previously hidden real bugs (jsonb double-encoding, bigint-as-string).
 *
 * Skipped entirely unless DATABASE_URL is set — see tests/integration/harness.ts.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase,
  createCookieJar,
  type InvokeResult
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { GET as tenantActivity } from "../../src/pages/api/v1/reports/tenant-activity";
import { GET as auditLog } from "../../src/pages/api/v1/logs/audit";
import { GET as decisionLogs } from "../../src/pages/api/v1/access/decision-logs";
import { DELETE as profileDelete } from "../../src/pages/api/v1/profiles/[id]";
import { hashPassword } from "../../src/lib/auth/password";
import { withTenant } from "../../src/lib/database/tenant-context";
import { resetRateLimitStoreForTests } from "../../src/lib/security/rate-limit";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = {
  tenantId: string;
  ownerProfileId: string;
  ownerTenantUserId: string;
  token: string;
};

async function bootstrapTenant(
  tenantCode = "acme",
  loginIdentifier = OWNER_LOGIN
): Promise<Bootstrap> {
  const setup = await invoke<{
    success: boolean;
    data: {
      tenantId: string;
      officeId: string;
      ownerProfileId: string;
      ownerIdentityId: string;
      ownerTenantUserId: string;
      ownerRoleId: string;
    };
  }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: `Tenant ${tenantCode}`,
      tenantCode,
      officeCode: "hq",
      officeName: "Head Office",
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
    body: { loginIdentifier: loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return {
    tenantId: setup.body.data.tenantId,
    ownerProfileId: setup.body.data.ownerProfileId,
    ownerTenantUserId: setup.body.data.ownerTenantUserId,
    token: login.body.data.token
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("API integration (real Postgres)", () => {
  beforeAll(async () => {
    await applyMigrations();
    // Repoint handlers at the least-privilege awcms_mini_app role so FORCE'd
    // RLS is actually enforced (as in production), not bypassed by a superuser.
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("setup wizard bootstraps a tenant once, then locks (2nd call 403)", async () => {
    const body = {
      tenantName: "Acme",
      tenantCode: "acme",
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: OWNER_LOGIN,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    };
    const first = await invoke<{ data: { tenantId: string } }>(
      setupInitialize,
      {
        method: "POST",
        path: "/api/v1/setup/initialize",
        headers: { "content-type": "application/json" },
        body
      }
    );
    expect(first.status).toBe(200);
    expect(first.body.data.tenantId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await invoke<{ error: { code: string } }>(setupInitialize, {
      method: "POST",
      path: "/api/v1/setup/initialize",
      headers: { "content-type": "application/json" },
      body
    });
    expect(second.status).toBe(403);
  });

  test("login succeeds with valid credentials and rejects a wrong password", async () => {
    const { tenantId } = await bootstrapTenant();

    const bad = await invoke<{ error: { code: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": tenantId
      },
      body: { loginIdentifier: OWNER_LOGIN, password: "wrong-password" },
      cookies: createCookieJar()
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  // Issue #437 — rate limiting on the public, expensive login endpoint,
  // complementary to (not a replacement for) the per-identity lockout
  // covered by the test above. Uses a *different* loginIdentifier on every
  // call so the per-identity lockout (AUTH_LOGIN_MAX_ATTEMPTS=5) never
  // trips — only the source-scoped (X-Forwarded-For + tenant) volumetric
  // limiter (AUTH_LOGIN_RATE_LIMIT_MAX, default 20) can explain a 429 here.
  test("rate limits login after AUTH_LOGIN_RATE_LIMIT_MAX attempts from the same source", async () => {
    resetRateLimitStoreForTests();
    const { tenantId } = await bootstrapTenant("rate-limit-tenant");
    const rateLimitMax = Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX ?? 20);
    const sourceIp = "203.0.113.77";

    let lastStatus = 0;
    let lastResponse: InvokeResult<{ error: { code: string } }> | undefined;

    for (let attempt = 0; attempt < rateLimitMax; attempt += 1) {
      const response = await invoke<{ error: { code: string } }>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": tenantId,
          "x-forwarded-for": sourceIp
        },
        body: {
          loginIdentifier: `no-such-user-${attempt}@example.com`,
          password: "wrong-password"
        },
        cookies: createCookieJar()
      });
      lastStatus = response.status;
      lastResponse = response;
    }

    // The first `rateLimitMax` attempts are all rejected as invalid
    // credentials (never a 429) — the endpoint's normal behavior.
    expect(lastStatus).toBe(401);
    expect(lastResponse?.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");

    const overLimit = await invoke<{ error: { code: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": tenantId,
        "x-forwarded-for": sourceIp
      },
      body: {
        loginIdentifier: "no-such-user-over-limit@example.com",
        password: "wrong-password"
      },
      cookies: createCookieJar()
    });

    expect(overLimit.status).toBe(429);
    expect(overLimit.body.error.code).toBe("RATE_LIMITED");
    expect(overLimit.response.headers.get("retry-after")).toBeTruthy();

    // A different source IP against the same tenant is unaffected — the
    // limiter is scoped per source, not a blanket per-tenant block.
    const differentSource = await invoke<{ error: { code: string } }>(
      authLogin,
      {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": tenantId,
          "x-forwarded-for": "198.51.100.20"
        },
        body: {
          loginIdentifier: "no-such-user-different-source@example.com",
          password: "wrong-password"
        },
        cookies: createCookieJar()
      }
    );

    expect(differentSource.status).toBe(401);
    expect(differentSource.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  test("ABAC guard: owner is allowed, a role-less user is default-denied (403)", async () => {
    const { tenantId, token } = await bootstrapTenant();

    // Owner has every permission (setup seeds the owner role with the full
    // catalog) -> allowed, and the response is RLS-scoped to this tenant.
    const allowed = await invoke<{ data: { tenantName: string } }>(
      tenantActivity,
      {
        method: "GET",
        path: "/api/v1/reports/tenant-activity",
        headers: {
          "x-awcms-mini-tenant-id": tenantId,
          authorization: `Bearer ${token}`
        }
      }
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.tenantName).toBe("Tenant acme");

    // A tenant-user with no role assignment -> default deny.
    const noRoleToken = await createRolelessUser(tenantId);
    const denied = await invoke<{ error: { code: string } }>(tenantActivity, {
      method: "GET",
      path: "/api/v1/reports/tenant-activity",
      headers: {
        "x-awcms-mini-tenant-id": tenantId,
        authorization: `Bearer ${noRoleToken}`
      }
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ACCESS_DENIED");
  });

  test("rejects a cross-tenant session (application-level tenant isolation)", async () => {
    const a = await bootstrapTenant("acme", "a-owner@example.com");

    // A second tenant exists (setup is a singleton, so tenant B is seeded via
    // the privileged client). It has no bearing on tenant A's session.
    const tenantBId = crypto.randomUUID();
    await getAdminSql()`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name, status)
      VALUES (${tenantBId}, 'beta', 'Beta', 'active')
    `;

    // A session issued for tenant A cannot be used with tenant B's tenant
    // header: resolveTenantContext looks up the session filtered by tenant_id,
    // so A's token never matches under tenant B -> 401.
    const crossTenant = await invoke<{ error: { code: string } }>(
      tenantActivity,
      {
        method: "GET",
        path: "/api/v1/reports/tenant-activity",
        headers: {
          "x-awcms-mini-tenant-id": tenantBId,
          authorization: `Bearer ${a.token}`
        }
      }
    );
    expect(crossTenant.status).toBe(401);
  });

  test("PostgreSQL RLS enforces tenant row isolation for the app DB role", async () => {
    // Handlers connect as the least-privilege awcms_mini_app role (see
    // provisionAppRole), for which FORCE'd RLS is enforced — so this is the
    // defense-in-depth backstop that was inert while the app ran as a superuser.
    const a = await bootstrapTenant("acme", "a-owner@example.com");

    // Seed a second tenant + an office for it using the privileged client
    // (which bypasses RLS, so it can write tenant B's row directly).
    const tenantBId = crypto.randomUUID();
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name, status)
      VALUES (${tenantBId}, 'beta', 'Beta', 'active')
    `;
    await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantBId}'`);
      await tx`
        INSERT INTO awcms_mini_offices (tenant_id, office_code, office_name, office_type, status)
        VALUES (${tenantBId}, 'b-hq', 'Beta HQ', 'head_office', 'active')
      `;
    });

    // Under tenant A's context, the app role sees ONLY tenant A's office (the
    // one setup created), never tenant B's — even though both rows exist. This
    // is the assertion that failed while RLS was bypassed for the app user.
    const aOfficeCount = await withTenant(
      getTestSql(),
      a.tenantId,
      async (tx) => {
        const rows = (await tx`
        SELECT count(*)::int AS n FROM awcms_mini_offices
      `) as { n: number }[];
        return rows[0]!.n;
      }
    );
    expect(aOfficeCount).toBe(1);
  });

  test("soft delete writes an audit event readable back with a safe jsonb payload", async () => {
    const { tenantId, ownerProfileId, token } = await bootstrapTenant();

    const del = await invoke<{ data: { status: string } }>(profileDelete, {
      method: "DELETE",
      path: `/api/v1/profiles/${ownerProfileId}`,
      params: { id: ownerProfileId },
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": tenantId,
        authorization: `Bearer ${token}`
      },
      body: { reason: "integration test soft delete" }
    });
    expect(del.status).toBe(200);
    expect(del.body.data.status).toBe("deleted");

    const audit = await invoke<{
      data: {
        events: {
          action: string;
          resourceType: string;
          attributes: Record<string, unknown> | null;
        }[];
      };
    }>(auditLog, {
      method: "GET",
      path: "/api/v1/logs/audit",
      headers: {
        "x-awcms-mini-tenant-id": tenantId,
        authorization: `Bearer ${token}`
      }
    });
    expect(audit.status).toBe(200);
    const event = audit.body.data.events.find(
      (e) => e.action === "delete" && e.resourceType === "profile"
    );
    expect(event).toBeDefined();
    // attributes must be a real nested object, not a double-encoded JSON
    // string (the class of bug that hit sync push and the audit helper).
    expect(typeof event!.attributes).toBe("object");
    expect(event!.attributes).toMatchObject({
      reason: "integration test soft delete"
    });
  });

  // Issue #435 (performance audit): `GET /api/v1/logs/audit` and
  // `GET /api/v1/access/decision-logs` gained keyset (`created_at, id`)
  // cursor pagination on top of their existing bounded page size, so an
  // admin can page past the first page instead of the tail being
  // permanently unreachable. Seeds well past one page directly via SQL
  // (bypassing the endpoint, matching `createRolelessUser` below) since
  // there is no write endpoint that produces audit events/decision logs in
  // bulk.
  test("audit log pages past the first 100 via nextCursor, oldest never repeated", async () => {
    const { tenantId, token } = await bootstrapTenant();
    const sql = getTestSql();

    await withTenant(sql, tenantId, async (tx) => {
      await tx`
        INSERT INTO awcms_mini_audit_events
          (tenant_id, module_key, action, resource_type, severity, message, created_at)
        SELECT ${tenantId}, 'logging', 'read', 'seed_resource', 'info', 'seed event',
               now() - (gs || ' seconds')::interval
        FROM generate_series(1, 105) AS gs
      `;
    });

    const headers = {
      "x-awcms-mini-tenant-id": tenantId,
      authorization: `Bearer ${token}`
    };

    const page1 = await invoke<{
      data: { events: { id: string }[]; nextCursor: string | null };
    }>(auditLog, { method: "GET", path: "/api/v1/logs/audit", headers });
    expect(page1.status).toBe(200);
    expect(page1.body.data.events).toHaveLength(100);
    expect(page1.body.data.nextCursor).not.toBeNull();

    const page2 = await invoke<{
      data: { events: { id: string }[]; nextCursor: string | null };
    }>(auditLog, {
      method: "GET",
      path: `/api/v1/logs/audit?cursor=${encodeURIComponent(page1.body.data.nextCursor!)}`,
      headers
    });
    expect(page2.status).toBe(200);
    // 105 seeded rows (plus whatever else this tenant already logged) means
    // more than 100 exist in total; page 2 holds whatever is left over.
    expect(page2.body.data.events.length).toBeGreaterThan(0);
    expect(page2.body.data.nextCursor).toBeNull();

    const page1Ids = new Set(page1.body.data.events.map((e) => e.id));
    for (const event of page2.body.data.events) {
      expect(page1Ids.has(event.id)).toBe(false);
    }

    const malformed = await invoke<{ error: { code: string } }>(auditLog, {
      method: "GET",
      path: "/api/v1/logs/audit?cursor=not-a-real-cursor",
      headers
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("decision logs page past the first 50 via nextCursor, oldest never repeated", async () => {
    const { tenantId, token } = await bootstrapTenant();
    const sql = getTestSql();

    await withTenant(sql, tenantId, async (tx) => {
      await tx`
        INSERT INTO awcms_mini_abac_decision_logs
          (tenant_id, module_key, activity_code, action, decision, reason, created_at)
        SELECT ${tenantId}, 'identity_access', 'access_control', 'read', 'allow', 'seed',
               now() - (gs || ' seconds')::interval
        FROM generate_series(1, 55) AS gs
      `;
    });

    const headers = {
      "x-awcms-mini-tenant-id": tenantId,
      authorization: `Bearer ${token}`
    };

    const page1 = await invoke<{
      data: { decisionLogs: { id: string }[]; nextCursor: string | null };
    }>(decisionLogs, {
      method: "GET",
      path: "/api/v1/access/decision-logs",
      headers
    });
    expect(page1.status).toBe(200);
    expect(page1.body.data.decisionLogs).toHaveLength(50);
    expect(page1.body.data.nextCursor).not.toBeNull();

    const page2 = await invoke<{
      data: { decisionLogs: { id: string }[]; nextCursor: string | null };
    }>(decisionLogs, {
      method: "GET",
      path: `/api/v1/access/decision-logs?cursor=${encodeURIComponent(page1.body.data.nextCursor!)}`,
      headers
    });
    expect(page2.status).toBe(200);
    expect(page2.body.data.decisionLogs.length).toBeGreaterThan(0);

    const page1Ids = new Set(page1.body.data.decisionLogs.map((e) => e.id));
    for (const entry of page2.body.data.decisionLogs) {
      expect(page1Ids.has(entry.id)).toBe(false);
    }
  });
});

/**
 * Creates a tenant-user with a valid login but no role assignment, returning
 * a live session token — the canonical "default deny" fixture.
 */
async function createRolelessUser(tenantId: string): Promise<string> {
  const sql = getTestSql();
  const passwordHash = await hashPassword("integration-test-norole-password");

  return withTenant(sql, tenantId, async (tx) => {
    const profile = (await tx`
        INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
        VALUES (${tenantId}, 'person', 'No Role') RETURNING id
      `) as { id: string }[];
    const identity = (await tx`
        INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${tenantId}, ${profile[0]!.id}, 'norole@example.com', ${passwordHash})
        RETURNING id
      `) as { id: string }[];
    await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id})
    `;
    return identity[0]!.id;
  }).then(async (identityId) => {
    // Log in through the real endpoint so the returned token is a genuine
    // issued session, not a hand-crafted one.
    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": tenantId
      },
      body: {
        loginIdentifier: "norole@example.com",
        password: "integration-test-norole-password"
      },
      cookies: createCookieJar()
    });
    void identityId;
    return login.body.data.token;
  });
}
