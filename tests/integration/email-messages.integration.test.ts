/**
 * Integration tests for the admin email message diagnostics/cancel endpoints
 * (Issue #499, epic #492) and the email health report against a real
 * PostgreSQL: queue listing/filtering, RLS/ABAC on both endpoints, the
 * cancel state machine (queued/retry_wait -> cancelled, rejected once
 * sent/failed), and the queue health aggregate.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { GET as listMessages } from "../../src/pages/api/v1/email/messages/index";
import { POST as cancelMessage } from "../../src/pages/api/v1/email/messages/[id]/cancel";
import { GET as emailHealthReport } from "../../src/pages/api/v1/reports/email-health";
import { invoke } from "./harness";

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

async function seedMessage(
  tenantId: string,
  status: string,
  overrides: { category?: string } = {}
): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_email_messages
      (tenant_id, category, to_address, to_address_hash, to_address_masked, subject, status)
    VALUES (
      ${tenantId}, ${overrides.category ?? "auth.password_reset"}, 'user@example.com',
      'sha256:fixture', 'u***@example.com', 'Reset your password', ${status}
    )
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

/** Provisions a second identity in the SAME tenant with NO email.* permissions granted — proves ABAC default-deny on both new endpoints. */
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

suite("email message diagnostics/cancel + email health report", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("lists messages tenant-wide, newest first, never exposing the raw address", async () => {
    const owner = await bootstrap();
    await seedMessage(owner.tenantId, "queued");
    await seedMessage(owner.tenantId, "failed");

    const result = await invoke<{
      data: { messages: { status: string; toAddressMasked: string }[] };
    }>(listMessages, {
      method: "GET",
      path: "/api/v1/email/messages",
      headers: authHeaders(owner)
    });

    expect(result.status).toBe(200);
    expect(result.body.data.messages).toHaveLength(2);
    for (const message of result.body.data.messages) {
      expect(message.toAddressMasked).toBe("u***@example.com");
    }
    expect(JSON.stringify(result.body)).not.toContain("user@example.com");
  });

  test("filters by status", async () => {
    const owner = await bootstrap();
    await seedMessage(owner.tenantId, "queued");
    await seedMessage(owner.tenantId, "failed");

    const result = await invoke<{ data: { messages: { status: string }[] } }>(
      listMessages,
      {
        method: "GET",
        path: "/api/v1/email/messages?status=failed",
        headers: authHeaders(owner)
      }
    );

    expect(result.body.data.messages).toHaveLength(1);
    expect(result.body.data.messages[0]!.status).toBe("failed");
  });

  test("rejects an invalid status filter", async () => {
    const owner = await bootstrap();

    const result = await invoke(listMessages, {
      method: "GET",
      path: "/api/v1/email/messages?status=bogus",
      headers: authHeaders(owner)
    });

    expect(result.status).toBe(400);
  });

  test("a queued message can be cancelled", async () => {
    const owner = await bootstrap();
    const id = await seedMessage(owner.tenantId, "queued");

    const result = await invoke<{ data: { status: string } }>(cancelMessage, {
      method: "POST",
      path: `/api/v1/email/messages/${id}/cancel`,
      headers: authHeaders(owner),
      params: { id }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.status).toBe("cancelled");

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT status FROM awcms_mini_email_messages WHERE id = ${id}
    `) as { status: string }[];
    expect(rows[0]!.status).toBe("cancelled");
  });

  test("a retry_wait message can be cancelled", async () => {
    const owner = await bootstrap();
    const id = await seedMessage(owner.tenantId, "retry_wait");

    const result = await invoke(cancelMessage, {
      method: "POST",
      path: `/api/v1/email/messages/${id}/cancel`,
      headers: authHeaders(owner),
      params: { id }
    });

    expect(result.status).toBe(200);
  });

  test("an already-sent message cannot be cancelled (409)", async () => {
    const owner = await bootstrap();
    const id = await seedMessage(owner.tenantId, "sent");

    const result = await invoke(cancelMessage, {
      method: "POST",
      path: `/api/v1/email/messages/${id}/cancel`,
      headers: authHeaders(owner),
      params: { id }
    });

    expect(result.status).toBe(409);
  });

  test("cancelling an unknown message id is a 404", async () => {
    const owner = await bootstrap();

    const result = await invoke(cancelMessage, {
      method: "POST",
      path: "/api/v1/email/messages/00000000-0000-0000-0000-000000000000/cancel",
      headers: authHeaders(owner),
      params: { id: "00000000-0000-0000-0000-000000000000" }
    });

    expect(result.status).toBe(404);
  });

  test("cancel records an audit event", async () => {
    const owner = await bootstrap();
    const id = await seedMessage(owner.tenantId, "queued");

    await invoke(cancelMessage, {
      method: "POST",
      path: `/api/v1/email/messages/${id}/cancel`,
      headers: authHeaders(owner),
      params: { id }
    });

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT action, resource_type, resource_id
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'message_cancelled'
    `) as { action: string; resource_type: string; resource_id: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.resource_type).toBe("email_message");
    expect(rows[0]!.resource_id).toBe(id);
  });

  test("RLS: tenant A cannot list or cancel tenant B's message", async () => {
    // `setup/initialize` is a one-time singleton per database — a *second*
    // tenant within the same test is provisioned directly via raw SQL,
    // never a second `setup/initialize` call.
    const ownerA = await bootstrap("tenant-a", "Tenant A");
    const admin = getAdminSql();
    const tenantBId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await admin`
      INSERT INTO awcms_mini_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${tenantBId}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
    `;
    const messageBId = await seedMessage(tenantBId, "queued");

    const list = await invoke<{ data: { messages: unknown[] } }>(listMessages, {
      method: "GET",
      path: "/api/v1/email/messages",
      headers: authHeaders(ownerA)
    });
    expect(list.body.data.messages).toHaveLength(0);

    const cancel = await invoke(cancelMessage, {
      method: "POST",
      path: `/api/v1/email/messages/${messageBId}/cancel`,
      headers: authHeaders(ownerA),
      params: { id: messageBId }
    });
    expect(cancel.status).toBe(404);
  });

  test("ABAC: a user with no email.* permissions is denied on both endpoints", async () => {
    const owner = await bootstrap();
    const noPermission = await provisionNoPermissionUser(owner.tenantId);
    const id = await seedMessage(owner.tenantId, "queued");
    const headers = {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": owner.tenantId,
      authorization: `Bearer ${noPermission.token}`
    };

    const list = await invoke(listMessages, {
      method: "GET",
      path: "/api/v1/email/messages",
      headers
    });
    expect(list.status).toBe(403);

    const cancel = await invoke(cancelMessage, {
      method: "POST",
      path: `/api/v1/email/messages/${id}/cancel`,
      headers,
      params: { id }
    });
    expect(cancel.status).toBe(403);
  });

  test("email health report reflects queued/failed/retry_wait/suppressed counts", async () => {
    const owner = await bootstrap();
    await seedMessage(owner.tenantId, "queued");
    await seedMessage(owner.tenantId, "failed");
    await seedMessage(owner.tenantId, "retry_wait");
    await seedMessage(owner.tenantId, "suppressed");

    const result = await invoke<{
      data: {
        queuedCount: number;
        failedCount: number;
        retryWaitCount: number;
        suppressedCount: number;
        hasFailedMessages: boolean;
        hasRetryBacklog: boolean;
        isHealthy: boolean;
      };
    }>(emailHealthReport, {
      method: "GET",
      path: "/api/v1/reports/email-health",
      headers: authHeaders(owner)
    });

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      queuedCount: 1,
      failedCount: 1,
      retryWaitCount: 1,
      suppressedCount: 1,
      hasFailedMessages: true,
      hasRetryBacklog: true,
      isHealthy: false
    });
  });
});
