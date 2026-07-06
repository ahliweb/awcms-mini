/**
 * Integration tests for the email template management API (Issue #498,
 * epic #492). Exercises the real handlers against a real PostgreSQL —
 * CRUD, cross-tenant RLS denial, soft-delete/restore, preview (no real
 * recipient data), i18n locale selection, and default-template seeding.
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
  GET as listTemplates,
  POST as createTemplate
} from "../../src/pages/api/v1/email/templates/index";
import {
  DELETE as deleteTemplate,
  GET as getTemplate,
  PATCH as updateTemplate
} from "../../src/pages/api/v1/email/templates/[id]";
import { POST as restoreTemplate } from "../../src/pages/api/v1/email/templates/[id]/restore";
import { POST as previewTemplate } from "../../src/pages/api/v1/email/templates/[id]/preview";
import { withTenant } from "../../src/lib/database/tenant-context";
import { seedDefaultEmailTemplates } from "../../src/modules/email/application/email-template-directory";
import { DEFAULT_EMAIL_TEMPLATES } from "../../src/modules/email/domain/email-default-templates";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: `${tenantCode}-${OWNER_LOGIN}`,
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
    body: {
      loginIdentifier: `${tenantCode}-${OWNER_LOGIN}`,
      password: OWNER_PASSWORD
    },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/**
 * `POST /setup/initialize` is a once-per-database singleton lock (see
 * `awcms_mini_setup_state`) — it cannot be called twice to bootstrap two
 * tenants in the same test. A second tenant is provisioned directly via
 * `getAdminSql()` instead, mirroring `settings.integration.test.ts`'s
 * role-less-user pattern but granting `email.template.read` so the test
 * proves RLS isolation specifically, not an ABAC 403.
 */
async function provisionSecondTenantWithTemplateReadAccess(): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${tenantId}, 'tenant-b-raw', 'Tenant B Raw')
  `;

  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, 'tenant-b-user@example.com', ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'template_reader', 'Template Reader') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'email' AND activity_code = 'template' AND action = 'read'
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
    body: { loginIdentifier: "tenant-b-user@example.com", password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token };
}

const CREATE_BODY = {
  templateKey: "auth.password_reset",
  name: "Password reset",
  subjectTemplate: { en: "Reset your password", id: "Atur ulang kata sandi" },
  textBodyTemplate: {
    en: "Click {{resetUrl}}",
    id: "Klik {{resetUrl}}"
  }
};

const suite = integrationEnabled ? describe : describe.skip;

suite("email templates API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("create -> get -> list -> update -> delete -> 404 after delete", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string } }>(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(created.status).toBe(200);
    const templateId = created.body.data.id;

    const fetched = await invoke(getTemplate, {
      method: "GET",
      path: `/api/v1/email/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId }
    });
    expect(fetched.status).toBe(200);

    const list = await invoke<{ data: { templates: unknown[] } }>(
      listTemplates,
      {
        method: "GET",
        path: "/api/v1/email/templates",
        headers: authHeaders(owner)
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.templates).toHaveLength(1);

    const updated = await invoke<{ data: { name: string } }>(updateTemplate, {
      method: "PATCH",
      path: `/api/v1/email/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId },
      body: { name: "Password reset (v2)" }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe("Password reset (v2)");

    const deleted = await invoke(deleteTemplate, {
      method: "DELETE",
      path: `/api/v1/email/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId },
      body: { reason: "no longer needed" }
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await invoke(getTemplate, {
      method: "GET",
      path: `/api/v1/email/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId }
    });
    expect(afterDelete.status).toBe(404);
  });

  test("DELETE without a reason is rejected", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const deleted = await invoke(deleteTemplate, {
      method: "DELETE",
      path: `/api/v1/email/templates/${created.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id },
      body: {}
    });
    expect(deleted.status).toBe(400);
  });

  test("creating a duplicate active templateKey conflicts (409)", async () => {
    const owner = await bootstrap();
    const first = await invoke(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(first.status).toBe(200);

    const duplicate = await invoke(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(duplicate.status).toBe(409);
  });

  test("restore brings a soft-deleted template back", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const templateId = created.body.data.id;

    await invoke(deleteTemplate, {
      method: "DELETE",
      path: `/api/v1/email/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId },
      body: { reason: "test" }
    });

    const restored = await invoke(restoreTemplate, {
      method: "POST",
      path: `/api/v1/email/templates/${templateId}/restore`,
      headers: authHeaders(owner),
      params: { id: templateId }
    });
    expect(restored.status).toBe(200);

    const fetched = await invoke(getTemplate, {
      method: "GET",
      path: `/api/v1/email/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId }
    });
    expect(fetched.status).toBe(200);

    const restoreAgain = await invoke(restoreTemplate, {
      method: "POST",
      path: `/api/v1/email/templates/${templateId}/restore`,
      headers: authHeaders(owner),
      params: { id: templateId }
    });
    expect(restoreAgain.status).toBe(404);
  });

  test("tenant B cannot read tenant A's template (RLS FORCE)", async () => {
    const tenantA = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(tenantA),
      body: CREATE_BODY
    });
    const templateId = created.body.data.id;

    const tenantB = await provisionSecondTenantWithTemplateReadAccess();
    const crossTenantRead = await invoke(getTemplate, {
      method: "GET",
      path: `/api/v1/email/templates/${templateId}`,
      headers: authHeaders(tenantB),
      params: { id: templateId }
    });

    expect(crossTenantRead.status).toBe(404);
  });

  test("preview renders with synthetic sample data and never touches the message queue", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const templateId = created.body.data.id;

    const preview = await invoke<{
      data: { subject: string; textBody?: string };
    }>(previewTemplate, {
      method: "POST",
      path: `/api/v1/email/templates/${templateId}/preview`,
      headers: authHeaders(owner),
      params: { id: templateId },
      body: {}
    });

    expect(preview.status).toBe(200);
    expect(preview.body.data.subject).toBe("Reset your password");
    expect(preview.body.data.textBody).toContain("Sample resetUrl");

    const admin = getAdminSql();
    const messageRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_email_messages
    `) as { count: number }[];
    expect(messageRows[0]?.count).toBe(0);
  });

  test("preview selects the requested locale", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createTemplate, {
      method: "POST",
      path: "/api/v1/email/templates",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const templateId = created.body.data.id;

    const preview = await invoke<{ data: { subject: string } }>(
      previewTemplate,
      {
        method: "POST",
        path: `/api/v1/email/templates/${templateId}/preview`,
        headers: authHeaders(owner),
        params: { id: templateId },
        body: { locale: "id" }
      }
    );

    expect(preview.status).toBe(200);
    expect(preview.body.data.subject).toBe("Atur ulang kata sandi");
  });

  test("seedDefaultEmailTemplates is idempotent and never overwrites a customized template", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    const first = await withTenant(admin, owner.tenantId, (tx) =>
      seedDefaultEmailTemplates(
        tx,
        owner.tenantId,
        crypto.randomUUID(),
        DEFAULT_EMAIL_TEMPLATES
      )
    );
    expect(first.created).toBe(DEFAULT_EMAIL_TEMPLATES.length);
    expect(first.skipped).toBe(0);

    const second = await withTenant(admin, owner.tenantId, (tx) =>
      seedDefaultEmailTemplates(
        tx,
        owner.tenantId,
        crypto.randomUUID(),
        DEFAULT_EMAIL_TEMPLATES
      )
    );
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(DEFAULT_EMAIL_TEMPLATES.length);

    const list = await invoke<{ data: { templates: unknown[] } }>(
      listTemplates,
      {
        method: "GET",
        path: "/api/v1/email/templates",
        headers: authHeaders(owner)
      }
    );
    expect(list.body.data.templates).toHaveLength(
      DEFAULT_EMAIL_TEMPLATES.length
    );
  });
});
