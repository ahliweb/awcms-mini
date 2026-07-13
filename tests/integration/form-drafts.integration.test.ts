/**
 * Integration tests for the Form Drafts API (Issue #484). Exercises the real
 * handlers against a real PostgreSQL via the shared harness — CRUD + submit
 * flow, RLS tenant isolation, ABAC default-deny, denylist rejection at the
 * endpoint level (not just the pure validator), submit idempotency, and the
 * retention/expiry application functions (not exposed over HTTP, so called
 * directly like `audit-purge.test.ts` presumably does for its own job).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listDrafts,
  POST as createDraft
} from "../../src/pages/api/v1/form-drafts/index";
import {
  DELETE as deleteDraft,
  GET as getDraft,
  PATCH as updateDraft
} from "../../src/pages/api/v1/form-drafts/[id]";
import { POST as submitDraft } from "../../src/pages/api/v1/form-drafts/[id]/submit";
import {
  expireOverdueFormDrafts,
  purgeExpiredFormDrafts
} from "../../src/modules/form-drafts/application/form-draft-purge";
import { withTenant } from "../../src/lib/database/tenant-context";
import { createLegalHold } from "../../src/modules/data-lifecycle/application/legal-hold-service";
import { legalHoldGuardPortAdapter } from "../../src/modules/data-lifecycle/application/legal-hold-guard-port-adapter";

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

type DraftBody = {
  id: string;
  moduleKey: string;
  wizardKey: string;
  currentStep: string;
  payload: Record<string, unknown>;
  status: string;
};

async function createTestDraft(b: Bootstrap): Promise<DraftBody> {
  const res = await invoke<{ data: DraftBody }>(createDraft, {
    method: "POST",
    path: "/api/v1/form-drafts",
    headers: authHeaders(b),
    body: {
      moduleKey: "admin_examples",
      wizardKey: "wizard_fixture",
      resourceType: "fixture",
      currentStep: "basic",
      payload: { title: "Demo" }
    }
  });
  expect(res.status).toBe(200);
  return res.body.data;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Form Drafts API (real Postgres)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("creates, reads, updates, and lists a draft", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    expect(draft.status).toBe("draft");
    expect(draft.payload).toEqual({ title: "Demo" });

    const read = await invoke<{ data: DraftBody }>(getDraft, {
      method: "GET",
      path: `/api/v1/form-drafts/${draft.id}`,
      headers: authHeaders(b),
      params: { id: draft.id }
    });
    expect(read.status).toBe(200);
    expect(read.body.data.currentStep).toBe("basic");

    const updated = await invoke<{ data: DraftBody }>(updateDraft, {
      method: "PATCH",
      path: `/api/v1/form-drafts/${draft.id}`,
      headers: authHeaders(b),
      params: { id: draft.id },
      body: { currentStep: "details", payload: { title: "Demo", notes: "x" } }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.currentStep).toBe("details");
    expect(updated.body.data.payload).toEqual({ title: "Demo", notes: "x" });

    const list = await invoke<{ data: { drafts: DraftBody[] } }>(listDrafts, {
      method: "GET",
      path: "/api/v1/form-drafts?moduleKey=admin_examples&wizardKey=wizard_fixture",
      headers: authHeaders(b)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.drafts).toHaveLength(1);
    expect(list.body.data.drafts[0]!.id).toBe(draft.id);
  });

  test("rejects a create request whose payload contains a forbidden field", async () => {
    const b = await bootstrap();

    const res = await invoke<{ error: { code: string; details: unknown } }>(
      createDraft,
      {
        method: "POST",
        path: "/api/v1/form-drafts",
        headers: authHeaders(b),
        body: {
          moduleKey: "admin_examples",
          wizardKey: "wizard_fixture",
          resourceType: "fixture",
          currentStep: "basic",
          payload: { title: "Demo", password: "hunter2" }
        }
      }
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("submit transitions draft->submitted and is idempotent on retry with the same key", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);
    const idempotencyKey = "test-submit-key-0001";

    const first = await invoke<{ data: DraftBody }>(submitDraft, {
      method: "POST",
      path: `/api/v1/form-drafts/${draft.id}/submit`,
      headers: { ...authHeaders(b), "idempotency-key": idempotencyKey },
      params: { id: draft.id }
    });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("submitted");

    // Retry with the same key -> replay, not a second transition/error.
    const retry = await invoke<{ data: DraftBody }>(submitDraft, {
      method: "POST",
      path: `/api/v1/form-drafts/${draft.id}/submit`,
      headers: { ...authHeaders(b), "idempotency-key": idempotencyKey },
      params: { id: draft.id }
    });
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(draft.id);

    // A second, genuinely new submit attempt on an already-submitted draft
    // (different key) is rejected — nothing left to transition.
    const secondAttempt = await invoke<{ error: { code: string } }>(
      submitDraft,
      {
        method: "POST",
        path: `/api/v1/form-drafts/${draft.id}/submit`,
        headers: { ...authHeaders(b), "idempotency-key": "different-key" },
        params: { id: draft.id }
      }
    );
    expect(secondAttempt.status).toBe(404);
  });

  test("submit requires an Idempotency-Key header", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    const res = await invoke<{ error: { code: string } }>(submitDraft, {
      method: "POST",
      path: `/api/v1/form-drafts/${draft.id}/submit`,
      headers: authHeaders(b),
      params: { id: draft.id }
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_REQUIRED");
  });

  test("delete (abandon) is idempotent-safe — repeating it returns 404, not a duplicate side effect", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    const first = await invoke<{ data: { deleted: boolean } }>(deleteDraft, {
      method: "DELETE",
      path: `/api/v1/form-drafts/${draft.id}`,
      headers: authHeaders(b),
      params: { id: draft.id }
    });
    expect(first.status).toBe(200);
    expect(first.body.data.deleted).toBe(true);

    const second = await invoke<{ error: { code: string } }>(deleteDraft, {
      method: "DELETE",
      path: `/api/v1/form-drafts/${draft.id}`,
      headers: authHeaders(b),
      params: { id: draft.id }
    });
    expect(second.status).toBe(404);
  });

  test("a deleted/submitted draft is no longer editable via PATCH", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    await invoke(deleteDraft, {
      method: "DELETE",
      path: `/api/v1/form-drafts/${draft.id}`,
      headers: authHeaders(b),
      params: { id: draft.id }
    });

    const patch = await invoke<{ error: { code: string } }>(updateDraft, {
      method: "PATCH",
      path: `/api/v1/form-drafts/${draft.id}`,
      headers: authHeaders(b),
      params: { id: draft.id },
      body: { currentStep: "details" }
    });
    expect(patch.status).toBe(404);
  });

  test("tenant A cannot read, update, or list tenant B's draft (RLS FORCE)", async () => {
    // `POST /setup/initialize` is a once-per-database singleton lock (see
    // `awcms_mini_setup_state`) — it cannot be called twice to create a
    // second tenant. Tenant B is inserted directly as the admin/superuser
    // role instead, same as `settings.integration.test.ts`'s cross-tenant
    // test does, bypassing RLS on purpose to seed the fixture.
    const a = await bootstrap("acme", "Acme");

    const admin = getAdminSql();
    const tenantBId = crypto.randomUUID();
    await admin`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
      VALUES (${tenantBId}, 'beta', 'Beta')
    `;
    const draftBRows = (await admin`
      INSERT INTO awcms_mini_form_drafts
        (tenant_id, module_key, wizard_key, resource_type, current_step, payload, created_by, updated_by)
      VALUES (
        ${tenantBId}, 'admin_examples', 'wizard_fixture', 'fixture', 'basic',
        ${{ title: "Beta secret draft" }}, ${crypto.randomUUID()}, ${crypto.randomUUID()}
      )
      RETURNING id
    `) as { id: string }[];
    const draftB = { id: draftBRows[0]!.id };

    const readAsA = await invoke<{ error: { code: string } }>(getDraft, {
      method: "GET",
      path: `/api/v1/form-drafts/${draftB.id}`,
      headers: authHeaders(a),
      params: { id: draftB.id }
    });
    expect(readAsA.status).toBe(404);

    const listAsA = await invoke<{ data: { drafts: DraftBody[] } }>(
      listDrafts,
      {
        method: "GET",
        path: "/api/v1/form-drafts",
        headers: authHeaders(a)
      }
    );
    expect(listAsA.body.data.drafts).toHaveLength(0);

    // Confirm tenant B's row genuinely still exists (RLS filtered it from A,
    // rather than it never having been created).
    const rows = (await admin`
      SELECT id FROM awcms_mini_form_drafts WHERE id = ${draftB.id}
    `) as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  test("default-deny: a role-less user cannot use any form-drafts endpoint", async () => {
    const b = await bootstrap();

    const sql = getAdminSql();
    const passwordHash = await Bun.password.hash("norole-password-123456");
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${b.tenantId}'`);
      const profile = (await tx`
        INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
        VALUES (${b.tenantId}, 'person', 'No Role') RETURNING id
      `) as { id: string }[];
      const identity = (await tx`
        INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${b.tenantId}, ${profile[0]!.id}, 'norole-drafts@example.com', ${passwordHash})
        RETURNING id
      `) as { id: string }[];
      await tx`
        INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
        VALUES (${b.tenantId}, ${identity[0]!.id})
      `;
    });

    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": b.tenantId
      },
      body: {
        loginIdentifier: "norole-drafts@example.com",
        password: "norole-password-123456"
      },
      cookies: createCookieJar()
    });
    expect(login.status).toBe(200);
    const headers = {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": b.tenantId,
      authorization: `Bearer ${login.body.data.token}`
    };

    const list = await invoke<{ error: { code: string } }>(listDrafts, {
      method: "GET",
      path: "/api/v1/form-drafts",
      headers
    });
    expect(list.status).toBe(403);

    const create = await invoke<{ error: { code: string } }>(createDraft, {
      method: "POST",
      path: "/api/v1/form-drafts",
      headers,
      body: {
        moduleKey: "admin_examples",
        wizardKey: "wizard_fixture",
        resourceType: "fixture",
        currentStep: "basic",
        payload: {}
      }
    });
    expect(create.status).toBe(403);
  });

  test("expireOverdueFormDrafts transitions an overdue draft to expired and audits it", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_form_drafts
      SET expires_at = now() - interval '1 hour'
      WHERE id = ${draft.id}
    `;

    const result = await expireOverdueFormDrafts(admin, b.tenantId);
    expect(result.expiredCount).toBe(1);

    const rows = (await admin`
      SELECT status FROM awcms_mini_form_drafts WHERE id = ${draft.id}
    `) as { status: string }[];
    expect(rows[0]!.status).toBe("expired");

    const auditRows = (await admin`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${b.tenantId} AND module_key = 'form_drafts' AND action = 'expire'
    `) as { action: string }[];
    expect(auditRows).toHaveLength(1);
  });

  test("purgeExpiredFormDrafts physically deletes an old expired draft past retention, and audits the purge", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_form_drafts
      SET status = 'expired', updated_at = now() - interval '31 days'
      WHERE id = ${draft.id}
    `;

    const result = await purgeExpiredFormDrafts(
      admin,
      b.tenantId,
      legalHoldGuardPortAdapter,
      { retentionDays: 30 }
    );
    expect(result.purgedCount).toBe(1);

    const rows = (await admin`
      SELECT id FROM awcms_mini_form_drafts WHERE id = ${draft.id}
    `) as { id: string }[];
    expect(rows).toHaveLength(0);

    const auditRows = (await admin`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${b.tenantId} AND module_key = 'form_drafts' AND action = 'purge'
    `) as { action: string }[];
    expect(auditRows).toHaveLength(1);
  });

  test("purgeExpiredFormDrafts does not delete a recently-expired draft still within retention", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_form_drafts
      SET status = 'expired', updated_at = now() - interval '1 day'
      WHERE id = ${draft.id}
    `;

    const result = await purgeExpiredFormDrafts(
      admin,
      b.tenantId,
      legalHoldGuardPortAdapter,
      { retentionDays: 30 }
    );
    expect(result.purgedCount).toBe(0);

    const rows = (await admin`
      SELECT id FROM awcms_mini_form_drafts WHERE id = ${draft.id}
    `) as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  test("legal hold on form_drafts.form_drafts blocks purgeExpiredFormDrafts entirely — held rows are never deleted (security-auditor finding, PR #773)", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_form_drafts
      SET status = 'expired', updated_at = now() - interval '31 days'
      WHERE id = ${draft.id}
    `;

    await withTenant(admin, b.tenantId, (tx) =>
      createLegalHold(
        tx,
        b.tenantId,
        "dddddddd-1111-1111-1111-111111111111",
        {
          descriptorKey: "form_drafts.form_drafts",
          scopeDescription: "All drafts under litigation hold.",
          reason:
            "Ongoing internal investigation, evidence preservation required.",
          authorityReference: "Internal Legal Ref #101/2026",
          endsAt: null
        },
        "corr-hold"
      )
    );

    const result = await purgeExpiredFormDrafts(
      admin,
      b.tenantId,
      legalHoldGuardPortAdapter,
      { retentionDays: 30 }
    );
    expect(result.purgedCount).toBe(0);

    const rows = (await admin`
      SELECT id FROM awcms_mini_form_drafts WHERE id = ${draft.id}
    `) as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  test("expireOverdueFormDrafts runs successfully under the real awcms_mini_worker role (Issue #683, epic #679)", async () => {
    const b = await bootstrap();
    const draft = await createTestDraft(b);

    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_form_drafts
      SET expires_at = now() - interval '1 hour'
      WHERE id = ${draft.id}
    `;

    // PR #703 review caught this live: without UPDATE on
    // awcms_mini_form_drafts, this call fails with "permission denied" —
    // the app-role-only tests above never exercise the real worker role.
    const result = await expireOverdueFormDrafts(
      getWorkerTestSql(),
      b.tenantId
    );
    expect(result.expiredCount).toBe(1);

    const rows = (await admin`
      SELECT status FROM awcms_mini_form_drafts WHERE id = ${draft.id}
    `) as { status: string }[];
    expect(rows[0]!.status).toBe("expired");
  });
});
