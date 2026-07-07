/**
 * Integration tests for announcement/notification email workflows (Issue
 * #497, epic #492). Exercises the real handlers against a real
 * PostgreSQL: targeting (explicit users/role/tenant), the two-tier ABAC
 * (bulk requires a stronger permission than an explicit-user send),
 * idempotency on the bulk-capable create endpoint, preview (count-only,
 * no queue writes), suppression-list exclusion, and audit.
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
import { POST as createAnnouncement } from "../../src/pages/api/v1/email/announcements/index";
import { POST as previewAnnouncement } from "../../src/pages/api/v1/email/announcements/preview";
import { withTenant } from "../../src/lib/database/tenant-context";
import { seedDefaultEmailTemplates } from "../../src/modules/email/application/email-template-directory";
import { DEFAULT_EMAIL_TEMPLATES } from "../../src/modules/email/domain/email-default-templates";

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
  const tenantUserId = tenantUserRows[0]!.id;

  // The announcement endpoints render an existing template — seed the base
  // defaults (Issue #498) for this tenant so "system.announcement"/
  // "workflow.task_assigned" resolve to a real, active template.
  await withTenant(admin, setup.body.data.tenantId, (tx) =>
    seedDefaultEmailTemplates(
      tx,
      setup.body.data.tenantId,
      tenantUserId,
      DEFAULT_EMAIL_TEMPLATES
    )
  );

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId
  };
}

function authHeaders(
  owner: Bootstrap,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`,
    ...extra
  };
}

/** Provisions a second identity in the SAME tenant granted only `email.notification.create` (no `email.announcement.create`) — proves the two-tier ABAC. */
async function provisionNotificationOnlyUser(
  tenantId: string
): Promise<{ token: string }> {
  const password = "integration-test-notification-only-password";
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Notification Only') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, 'notification-only@example.com', ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'notifier', 'Notifier') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'email' AND activity_code = 'notification' AND action = 'create'
    `) as { id: string }[];

    await tx`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      VALUES (${tenantId}, ${role[0]!.id}, ${permission[0]!.id})
    `;
    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier: "notification-only@example.com", password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { token: login.body.data.token };
}

const ANNOUNCEMENT_BODY = {
  templateKey: "system.announcement",
  variables: {
    title: "Big news",
    body: "Something happened.",
    actionUrl: "https://example.com"
  },
  target: { type: "tenant" }
};

const suite = integrationEnabled ? describe : describe.skip;

suite("email announcements API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("preview returns a count and sample without touching the message queue", async () => {
    const owner = await bootstrap();

    const preview = await invoke<{
      data: { matchedCount: number; sample: { subject: string } };
    }>(previewAnnouncement, {
      method: "POST",
      path: "/api/v1/email/announcements/preview",
      headers: authHeaders(owner),
      body: ANNOUNCEMENT_BODY
    });

    expect(preview.status).toBe(200);
    expect(preview.body.data.matchedCount).toBe(1);
    expect(preview.body.data.sample.subject).toBe("Big news");

    const admin = getAdminSql();
    const messageRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_email_messages
    `) as { count: number }[];
    expect(messageRows[0]?.count).toBe(0);
  });

  test("create with an explicit user list enqueues one message and requires only the base permission", async () => {
    const owner = await bootstrap();
    const notifier = await provisionNotificationOnlyUser(owner.tenantId);

    const result = await invoke<{
      data: { recipientCount: number; correlationId: string };
    }>(createAnnouncement, {
      method: "POST",
      path: "/api/v1/email/announcements",
      headers: authHeaders(
        { ...owner, token: notifier.token },
        { "idempotency-key": "test-key-1" }
      ),
      body: {
        templateKey: "workflow.task_assigned",
        variables: {
          taskTitle: "Review PR",
          assignedBy: "Owner",
          dueAt: "tomorrow",
          taskUrl: "https://example.com/task"
        },
        target: { type: "users", userIds: [owner.tenantUserId] }
      }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.recipientCount).toBe(1);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT category, template_key, priority, correlation_id
      FROM awcms_mini_email_messages
      WHERE tenant_id = ${owner.tenantId}
    `) as {
      category: string;
      template_key: string;
      priority: string;
      correlation_id: string;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("workflow.task_assigned");
    expect(rows[0]!.priority).toBe("high");
    expect(rows[0]!.correlation_id).toBe(result.body.data.correlationId);
  });

  test("a bulk (tenant-wide) send is denied for a role with only the base notification permission", async () => {
    const owner = await bootstrap();
    const notifier = await provisionNotificationOnlyUser(owner.tenantId);

    const result = await invoke(createAnnouncement, {
      method: "POST",
      path: "/api/v1/email/announcements",
      headers: authHeaders(
        { ...owner, token: notifier.token },
        { "idempotency-key": "test-key-bulk-denied" }
      ),
      body: ANNOUNCEMENT_BODY
    });

    expect(result.status).toBe(403);
  });

  test("a bulk (tenant-wide) send succeeds for the owner (has both permissions) and enqueues one row per active user", async () => {
    const owner = await bootstrap();

    const result = await invoke<{ data: { recipientCount: number } }>(
      createAnnouncement,
      {
        method: "POST",
        path: "/api/v1/email/announcements",
        headers: authHeaders(owner, { "idempotency-key": "test-key-bulk-ok" }),
        body: ANNOUNCEMENT_BODY
      }
    );

    expect(result.status).toBe(200);
    expect(result.body.data.recipientCount).toBe(1);
  });

  test("missing Idempotency-Key is rejected", async () => {
    const owner = await bootstrap();

    const result = await invoke(createAnnouncement, {
      method: "POST",
      path: "/api/v1/email/announcements",
      headers: authHeaders(owner),
      body: ANNOUNCEMENT_BODY
    });

    expect(result.status).toBe(400);
  });

  test("idempotency: replaying the same key+body returns the same response without a duplicate enqueue", async () => {
    const owner = await bootstrap();
    const headers = authHeaders(owner, { "idempotency-key": "replay-key" });

    const first = await invoke<{ data: { recipientCount: number } }>(
      createAnnouncement,
      {
        method: "POST",
        path: "/api/v1/email/announcements",
        headers,
        body: ANNOUNCEMENT_BODY
      }
    );
    expect(first.status).toBe(200);

    const second = await invoke<{ data: { recipientCount: number } }>(
      createAnnouncement,
      {
        method: "POST",
        path: "/api/v1/email/announcements",
        headers,
        body: ANNOUNCEMENT_BODY
      }
    );
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_email_messages
      WHERE tenant_id = ${owner.tenantId}
    `) as { count: number }[];
    expect(rows[0]?.count).toBe(1);
  });

  test("same Idempotency-Key with a different body conflicts (409)", async () => {
    const owner = await bootstrap();
    const headers = authHeaders(owner, { "idempotency-key": "conflict-key" });

    const first = await invoke(createAnnouncement, {
      method: "POST",
      path: "/api/v1/email/announcements",
      headers,
      body: ANNOUNCEMENT_BODY
    });
    expect(first.status).toBe(200);

    const second = await invoke(createAnnouncement, {
      method: "POST",
      path: "/api/v1/email/announcements",
      headers,
      body: { ...ANNOUNCEMENT_BODY, variables: { title: "Different" } }
    });
    expect(second.status).toBe(409);
  });

  test("a suppressed recipient is excluded from targeting", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    // The suppression list stores a hash, not the raw identifier — insert
    // the real hash via the same normalize/hash pipeline the app uses
    // (`resolveAnnouncementTargets`), not the raw login_identifier.
    const identityRows = (await admin`
      SELECT i.login_identifier FROM awcms_mini_tenant_users tu
      JOIN awcms_mini_identities i ON i.id = tu.identity_id
      WHERE tu.id = ${owner.tenantUserId}
    `) as { login_identifier: string }[];
    const normalized = identityRows[0]!.login_identifier.trim().toLowerCase();
    const hash = `sha256:${new Bun.CryptoHasher("sha256").update(normalized).digest("hex")}`;

    await admin`
      INSERT INTO awcms_mini_email_suppression_list
        (tenant_id, recipient_hash, recipient_masked, reason)
      VALUES (${owner.tenantId}, ${hash}, 'o***@example.com', 'manual')
    `;

    const preview = await invoke<{ data: { matchedCount: number } }>(
      previewAnnouncement,
      {
        method: "POST",
        path: "/api/v1/email/announcements/preview",
        headers: authHeaders(owner),
        body: ANNOUNCEMENT_BODY
      }
    );

    expect(preview.body.data.matchedCount).toBe(0);
  });

  test("audit event records target type, template key, and recipient count", async () => {
    const owner = await bootstrap();

    await invoke(createAnnouncement, {
      method: "POST",
      path: "/api/v1/email/announcements",
      headers: authHeaders(owner, { "idempotency-key": "audit-key" }),
      body: ANNOUNCEMENT_BODY
    });

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT action, resource_type, attributes
      FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'announcement_sent'
    `) as {
      action: string;
      resource_type: string;
      attributes: Record<string, unknown>;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.resource_type).toBe("email_announcement");
    expect(rows[0]!.attributes.targetType).toBe("tenant");
    expect(rows[0]!.attributes.templateKey).toBe("system.announcement");
    expect(rows[0]!.attributes.recipientCount).toBe(1);
  });
});
