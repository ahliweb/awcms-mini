/**
 * Integration tests for the admin suppression list CRUD endpoints (Issue
 * #499, epic #492) against a real PostgreSQL: create/list/delete, ABAC,
 * audit, and redaction (never a raw recipient address in a response or
 * audit event).
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
  GET as listSuppressions,
  POST as createSuppression
} from "../../src/pages/api/v1/email/suppressions/index";
import { DELETE as deleteSuppression } from "../../src/pages/api/v1/email/suppressions/[id]";

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

async function provisionNoPermissionUser(
  tenantId: string
): Promise<{ token: string }> {
  const password = "integration-test-no-permission-password";
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'No Permission') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, 'no-permission@example.com', ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id})
    `;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier: "no-permission@example.com", password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { token: login.body.data.token };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("email suppression list API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("creates a suppression entry, never returning the raw recipient", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: { id: string; recipientMasked: string; reason: string };
    }>(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers: authHeaders(owner),
      body: { recipient: "bounced-user@example.com", reason: "bounced" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.recipientMasked).toBe("b***********@example.com");
    expect(result.body.data.reason).toBe("bounced");
    expect(JSON.stringify(result.body)).not.toContain(
      "bounced-user@example.com"
    );
  });

  test("creating the same recipient twice is an idempotent no-op", async () => {
    const owner = await bootstrap();
    const body = { recipient: "dup@example.com", reason: "manual" };

    const first = await invoke<{ data: { id: string } }>(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers: authHeaders(owner),
      body
    });
    expect(first.status).toBe(200);

    const second = await invoke<{ data: { alreadySuppressed?: boolean } }>(
      createSuppression,
      {
        method: "POST",
        path: "/api/v1/email/suppressions",
        headers: authHeaders(owner),
        body
      }
    );
    expect(second.status).toBe(200);
    expect(second.body.data.alreadySuppressed).toBe(true);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_email_suppression_list
      WHERE tenant_id = ${owner.tenantId}
    `) as { count: number }[];
    expect(rows[0]?.count).toBe(1);
  });

  test("rejects an invalid recipient/reason", async () => {
    const owner = await bootstrap();

    const result = await invoke(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers: authHeaders(owner),
      body: { recipient: "not-an-email", reason: "manual" }
    });

    expect(result.status).toBe(400);
  });

  test("lists suppression entries newest first, masked only", async () => {
    const owner = await bootstrap();
    await invoke(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers: authHeaders(owner),
      body: { recipient: "one@example.com", reason: "manual" }
    });
    await invoke(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers: authHeaders(owner),
      body: { recipient: "two@example.com", reason: "complained" }
    });

    const result = await invoke<{ data: { entries: { id: string }[] } }>(
      listSuppressions,
      {
        method: "GET",
        path: "/api/v1/email/suppressions",
        headers: authHeaders(owner)
      }
    );

    expect(result.status).toBe(200);
    expect(result.body.data.entries).toHaveLength(2);
    expect(JSON.stringify(result.body)).not.toContain("one@example.com");
    expect(JSON.stringify(result.body)).not.toContain("two@example.com");
  });

  test("deletes a suppression entry", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers: authHeaders(owner),
      body: { recipient: "remove-me@example.com", reason: "manual" }
    });
    const id = created.body.data.id;

    const result = await invoke(deleteSuppression, {
      method: "DELETE",
      path: `/api/v1/email/suppressions/${id}`,
      headers: authHeaders(owner),
      params: { id }
    });

    expect(result.status).toBe(200);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_email_suppression_list
      WHERE tenant_id = ${owner.tenantId}
    `) as { count: number }[];
    expect(rows[0]?.count).toBe(0);
  });

  test("deleting an unknown id is a 404", async () => {
    const owner = await bootstrap();

    const result = await invoke(deleteSuppression, {
      method: "DELETE",
      path: "/api/v1/email/suppressions/00000000-0000-0000-0000-000000000000",
      headers: authHeaders(owner),
      params: { id: "00000000-0000-0000-0000-000000000000" }
    });

    expect(result.status).toBe(404);
  });

  test("create and delete each record a distinct audit event", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers: authHeaders(owner),
      body: { recipient: "audit-me@example.com", reason: "manual" }
    });
    const id = created.body.data.id;

    await invoke(deleteSuppression, {
      method: "DELETE",
      path: `/api/v1/email/suppressions/${id}`,
      headers: authHeaders(owner),
      params: { id }
    });

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT action, resource_type, attributes
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId}
        AND action IN ('suppression_created', 'suppression_deleted')
      ORDER BY created_at
    `) as {
      action: string;
      resource_type: string;
      attributes: Record<string, unknown>;
    }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.action).toBe("suppression_created");
    expect(rows[1]!.action).toBe("suppression_deleted");
    for (const row of rows) {
      expect(row.resource_type).toBe("email_suppression");
      expect(JSON.stringify(row.attributes)).not.toContain(
        "audit-me@example.com"
      );
    }
  });

  test("RLS: tenant A cannot see or delete tenant B's suppression entry", async () => {
    // `setup/initialize` is a one-time singleton per database (see
    // provisionNoPermissionUser's own precedent elsewhere in this session) —
    // a *second* tenant within the same test must be provisioned directly
    // via raw SQL, never a second `setup/initialize` call.
    const ownerA = await bootstrap("tenant-a", "Tenant A");
    const admin = getAdminSql();
    const tenantBId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await admin`
      INSERT INTO awcms_mini_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${tenantBId}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
    `;
    const createdRows = (await admin`
      INSERT INTO awcms_mini_email_suppression_list
        (tenant_id, recipient_hash, recipient_masked, reason)
      VALUES (${tenantBId}, 'sha256:tenant-b-fixture', 't***@example.com', 'manual')
      RETURNING id
    `) as { id: string }[];
    const idB = createdRows[0]!.id;

    const list = await invoke<{ data: { entries: unknown[] } }>(
      listSuppressions,
      {
        method: "GET",
        path: "/api/v1/email/suppressions",
        headers: authHeaders(ownerA)
      }
    );
    expect(list.body.data.entries).toHaveLength(0);

    const del = await invoke(deleteSuppression, {
      method: "DELETE",
      path: `/api/v1/email/suppressions/${idB}`,
      headers: authHeaders(ownerA),
      params: { id: idB }
    });
    expect(del.status).toBe(404);
  });

  test("ABAC: a user with no email.* permissions is denied on list/create/delete", async () => {
    const owner = await bootstrap();
    const noPermission = await provisionNoPermissionUser(owner.tenantId);
    const headers = {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": owner.tenantId,
      authorization: `Bearer ${noPermission.token}`
    };

    const list = await invoke(listSuppressions, {
      method: "GET",
      path: "/api/v1/email/suppressions",
      headers
    });
    expect(list.status).toBe(403);

    const create = await invoke(createSuppression, {
      method: "POST",
      path: "/api/v1/email/suppressions",
      headers,
      body: { recipient: "denied@example.com", reason: "manual" }
    });
    expect(create.status).toBe(403);

    const del = await invoke(deleteSuppression, {
      method: "DELETE",
      path: "/api/v1/email/suppressions/00000000-0000-0000-0000-000000000000",
      headers,
      params: { id: "00000000-0000-0000-0000-000000000000" }
    });
    expect(del.status).toBe(403);
  });
});
