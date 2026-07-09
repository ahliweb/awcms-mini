/**
 * Integration tests for the tenant domain management API (Issue #562, epic
 * #555) against a real PostgreSQL. Exercises the real handlers — CRUD,
 * cross-tenant RLS denial (generic 404), duplicate-hostname 409 (both
 * same-tenant and cross-tenant, indistinguishable response), soft-delete-
 * only, `verify`/`set-primary` idempotency + status gating, `set-primary`
 * atomicity, and the never-expose-`verification_token_hash` invariant.
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
  GET as listDomains,
  POST as createDomain
} from "../../src/pages/api/v1/tenant/domains/index";
import {
  DELETE as deleteDomain,
  GET as getDomain,
  PATCH as updateDomain
} from "../../src/pages/api/v1/tenant/domains/[id]";
import { POST as verifyDomain } from "../../src/pages/api/v1/tenant/domains/[id]/verify";
import { POST as setPrimaryDomain } from "../../src/pages/api/v1/tenant/domains/[id]/set-primary";

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
 * `POST /setup/initialize` is a once-per-database singleton lock — a second
 * tenant with a real owner/session is provisioned directly, same pattern
 * `email-templates.integration.test.ts`'s
 * `provisionSecondTenantWithTemplateReadAccess` uses, granting
 * `tenant_domain.domains.read` specifically so the cross-tenant test proves
 * RLS isolation, not merely an ABAC 403.
 */
async function provisionSecondTenantWithDomainReadAccess(): Promise<Bootstrap> {
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
      VALUES (${tenantId}, ${profile[0]!.id}, 'tenant-b-domain-user@example.com', ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'domain_reader', 'Domain Reader') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'tenant_domain' AND activity_code = 'domains' AND action = 'read'
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
    body: { loginIdentifier: "tenant-b-domain-user@example.com", password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token };
}

const CREATE_BODY = {
  hostname: "shop.example.com",
  domainType: "custom_domain",
  verificationMethod: "manual"
};

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant domain management API (Issue #562)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("create -> get -> list -> update -> delete -> 404 after delete", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string; status: string } }>(
      createDomain,
      {
        method: "POST",
        path: "/api/v1/tenant/domains",
        headers: authHeaders(owner),
        body: CREATE_BODY
      }
    );
    expect(created.status).toBe(200);
    expect(created.body.data.status).toBe("pending_verification");
    const domainId = created.body.data.id;

    const fetched = await invoke(getDomain, {
      method: "GET",
      path: `/api/v1/tenant/domains/${domainId}`,
      headers: authHeaders(owner),
      params: { id: domainId }
    });
    expect(fetched.status).toBe(200);

    const list = await invoke<{ data: { domains: unknown[] } }>(listDomains, {
      method: "GET",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.domains).toHaveLength(1);

    const updated = await invoke<{ data: { routeMode: string } }>(
      updateDomain,
      {
        method: "PATCH",
        path: `/api/v1/tenant/domains/${domainId}`,
        headers: authHeaders(owner),
        params: { id: domainId },
        body: { routeMode: "legacy_blog" }
      }
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data.routeMode).toBe("legacy_blog");

    const deleted = await invoke(deleteDomain, {
      method: "DELETE",
      path: `/api/v1/tenant/domains/${domainId}`,
      headers: authHeaders(owner),
      params: { id: domainId },
      body: { reason: "no longer needed" }
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await invoke(getDomain, {
      method: "GET",
      path: `/api/v1/tenant/domains/${domainId}`,
      headers: authHeaders(owner),
      params: { id: domainId }
    });
    expect(afterDelete.status).toBe(404);
  });

  test("DELETE without a reason is rejected", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const deleted = await invoke(deleteDomain, {
      method: "DELETE",
      path: `/api/v1/tenant/domains/${created.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id },
      body: {}
    });
    expect(deleted.status).toBe(400);
  });

  test("delete is soft-delete only — the row survives and the hostname frees up for reuse", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const domainId = created.body.data.id;

    const deleted = await invoke(deleteDomain, {
      method: "DELETE",
      path: `/api/v1/tenant/domains/${domainId}`,
      headers: authHeaders(owner),
      params: { id: domainId },
      body: { reason: "moving off platform" }
    });
    expect(deleted.status).toBe(200);

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT id, deleted_at FROM awcms_mini_tenant_domains WHERE id = ${domainId}
    `) as { id: string; deleted_at: Date | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();

    // The freed hostname can be re-created.
    const recreated = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(recreated.status).toBe(200);
    expect(recreated.body.data.id).not.toBe(domainId);
  });

  test("create rejects an invalid hostname", async () => {
    const owner = await bootstrap();

    const invalidCases = [
      "",
      "not a hostname",
      "-leading-hyphen.com",
      "double..dot.com",
      "has_underscore.com",
      "with:a:port.com:8443"
    ];

    for (const hostname of invalidCases) {
      const result = await invoke(createDomain, {
        method: "POST",
        path: "/api/v1/tenant/domains",
        headers: authHeaders(owner),
        body: { ...CREATE_BODY, hostname }
      });
      expect(result.status).toBe(400);
    }
  });

  test("create rejects a duplicate normalized hostname for the same tenant with a generic 409", async () => {
    const owner = await bootstrap();

    const first = await invoke(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(first.status).toBe(200);

    const duplicate = await invoke(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      // Different case/whitespace, same normalized hostname.
      body: { ...CREATE_BODY, hostname: " Shop.Example.com " }
    });
    expect(duplicate.status).toBe(409);
  });

  test("create rejects a hostname already mapped to a DIFFERENT tenant with the exact same generic 409 (no cross-tenant leak)", async () => {
    const owner = await bootstrap("dup-tenant-a", "Dup Tenant A");
    const first = await invoke(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(first.status).toBe(200);

    const otherOwner = await provisionSecondTenantWithDomainReadAccess();
    // Grant create too — reuse the same raw-provisioning approach for a
    // second permission on the same role.
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${otherOwner.tenantId}, r.id, p.id
      FROM awcms_mini_roles r, awcms_mini_permissions p
      WHERE r.tenant_id = ${otherOwner.tenantId} AND r.role_code = 'domain_reader'
        AND p.module_key = 'tenant_domain' AND p.activity_code = 'domains' AND p.action = 'create'
    `;

    const crossTenantDuplicate = await invoke(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(otherOwner),
      body: CREATE_BODY
    });

    const sameTenantDuplicate = await invoke(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    expect(crossTenantDuplicate.status).toBe(409);
    expect(sameTenantDuplicate.status).toBe(409);
    // Identical error shape regardless of which tenant already owns the
    // hostname — Issue #562 §Security notes binding rule.
    expect(crossTenantDuplicate.body).toEqual(sameTenantDuplicate.body);
  });

  test("tenant B cannot read tenant A's domain (RLS FORCE) — generic 404, same as an unknown id", async () => {
    const tenantA = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(tenantA),
      body: CREATE_BODY
    });
    const domainId = created.body.data.id;

    const tenantB = await provisionSecondTenantWithDomainReadAccess();

    const crossTenantRead = await invoke(getDomain, {
      method: "GET",
      path: `/api/v1/tenant/domains/${domainId}`,
      headers: authHeaders(tenantB),
      params: { id: domainId }
    });
    const unknownIdRead = await invoke(getDomain, {
      method: "GET",
      path: `/api/v1/tenant/domains/${crypto.randomUUID()}`,
      headers: authHeaders(tenantB),
      params: { id: crypto.randomUUID() }
    });

    expect(crossTenantRead.status).toBe(404);
    expect(unknownIdRead.status).toBe(404);
    expect(crossTenantRead.body).toEqual(unknownIdRead.body);
  });

  test("no response ever includes verification_token_hash", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: Record<string, unknown> }>(
      createDomain,
      {
        method: "POST",
        path: "/api/v1/tenant/domains",
        headers: authHeaders(owner),
        body: CREATE_BODY
      }
    );
    expect(created.status).toBe(200);
    expect(Object.keys(created.body.data)).not.toContain(
      "verificationTokenHash"
    );
    expect(Object.keys(created.body.data)).not.toContain(
      "verification_token_hash"
    );

    const list = await invoke<{ data: { domains: Record<string, unknown>[] } }>(
      listDomains,
      {
        method: "GET",
        path: "/api/v1/tenant/domains",
        headers: authHeaders(owner)
      }
    );
    for (const entry of list.body.data.domains) {
      expect(Object.keys(entry)).not.toContain("verificationTokenHash");
    }
  });

  // -----------------------------------------------------------------
  // verify
  // -----------------------------------------------------------------

  test("verify requires an Idempotency-Key header", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const result = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${created.body.data.id}/verify`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id }
    });
    expect(result.status).toBe(400);
  });

  test("verify flips status to active for a domain with a verification_method configured", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const domainId = created.body.data.id;

    const verified = await invoke<{
      data: { status: string; verifiedAt: string | null };
    }>(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${domainId}/verify`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: domainId }
    });
    expect(verified.status).toBe(200);
    expect(verified.body.data.status).toBe("active");
    expect(verified.body.data.verifiedAt).not.toBeNull();
  });

  test("verify rejects a domain with no verification_method configured", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      // No verificationMethod at all.
      body: { hostname: "no-method.example.com", domainType: "custom_domain" }
    });

    const result = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${created.body.data.id}/verify`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: created.body.data.id }
    });
    expect(result.status).toBe(400);
  });

  test("verify rejects a suspended domain", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const domainId = created.body.data.id;

    const suspended = await invoke(updateDomain, {
      method: "PATCH",
      path: `/api/v1/tenant/domains/${domainId}`,
      headers: authHeaders(owner),
      params: { id: domainId },
      body: { status: "suspended" }
    });
    expect(suspended.status).toBe(200);

    const result = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${domainId}/verify`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: domainId }
    });
    expect(result.status).toBe(409);
  });

  test("PATCH cannot set status directly to active — only POST .../verify can", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const result = await invoke(updateDomain, {
      method: "PATCH",
      path: `/api/v1/tenant/domains/${created.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id },
      body: { status: "active" }
    });
    expect(result.status).toBe(400);
  });

  test("verify: same Idempotency-Key + same request replays the stored response; same key + different request conflicts", async () => {
    const owner = await bootstrap();
    const first = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const second = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { ...CREATE_BODY, hostname: "second.example.com" }
    });

    const idempotencyKey = crypto.randomUUID();

    const firstVerify = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${first.body.data.id}/verify`,
      headers: { ...authHeaders(owner), "idempotency-key": idempotencyKey },
      params: { id: first.body.data.id }
    });
    expect(firstVerify.status).toBe(200);

    const replay = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${first.body.data.id}/verify`,
      headers: { ...authHeaders(owner), "idempotency-key": idempotencyKey },
      params: { id: first.body.data.id }
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(firstVerify.body);

    // Same key, different domain id -> different request hash -> conflict.
    const conflict = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${second.body.data.id}/verify`,
      headers: { ...authHeaders(owner), "idempotency-key": idempotencyKey },
      params: { id: second.body.data.id }
    });
    expect(conflict.status).toBe(409);
  });

  // -----------------------------------------------------------------
  // set-primary
  // -----------------------------------------------------------------

  test("set-primary requires an Idempotency-Key header", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const result = await invoke(setPrimaryDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${created.body.data.id}/set-primary`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id }
    });
    expect(result.status).toBe(400);
  });

  test("set-primary rejects a non-active (unverified) domain", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const result = await invoke(setPrimaryDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${created.body.data.id}/set-primary`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: created.body.data.id }
    });
    expect(result.status).toBe(409);
  });

  test("set-primary atomically swaps the primary domain — the previous primary is cleared, only one is ever primary at a time", async () => {
    const owner = await bootstrap();

    const first = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const second = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { ...CREATE_BODY, hostname: "second-primary.example.com" }
    });

    for (const id of [first.body.data.id, second.body.data.id]) {
      const verified = await invoke(verifyDomain, {
        method: "POST",
        path: `/api/v1/tenant/domains/${id}/verify`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id }
      });
      expect(verified.status).toBe(200);
    }

    const setFirstPrimary = await invoke<{ data: { isPrimary: boolean } }>(
      setPrimaryDomain,
      {
        method: "POST",
        path: `/api/v1/tenant/domains/${first.body.data.id}/set-primary`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: first.body.data.id }
      }
    );
    expect(setFirstPrimary.status).toBe(200);
    expect(setFirstPrimary.body.data.isPrimary).toBe(true);

    const setSecondPrimary = await invoke<{ data: { isPrimary: boolean } }>(
      setPrimaryDomain,
      {
        method: "POST",
        path: `/api/v1/tenant/domains/${second.body.data.id}/set-primary`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: second.body.data.id }
      }
    );
    expect(setSecondPrimary.status).toBe(200);
    expect(setSecondPrimary.body.data.isPrimary).toBe(true);

    const admin = getAdminSql();
    const primaryRows = (await admin`
      SELECT id, is_primary FROM awcms_mini_tenant_domains
      WHERE tenant_id = ${owner.tenantId} AND is_primary = true AND deleted_at IS NULL
    `) as { id: string; is_primary: boolean }[];

    // Exactly one primary domain for this tenant, and it is the second one.
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0]?.id).toBe(second.body.data.id);

    const firstAfter = await invoke<{ data: { isPrimary: boolean } }>(
      getDomain,
      {
        method: "GET",
        path: `/api/v1/tenant/domains/${first.body.data.id}`,
        headers: authHeaders(owner),
        params: { id: first.body.data.id }
      }
    );
    expect(firstAfter.body.data.isPrimary).toBe(false);
  });

  test("set-primary under concurrent first-time race: exactly one request wins, the loser gets a clean 409 (not a raw constraint error)", async () => {
    const owner = await bootstrap();

    const first = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const second = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { ...CREATE_BODY, hostname: "second-race-primary.example.com" }
    });

    for (const id of [first.body.data.id, second.body.data.id]) {
      const verified = await invoke(verifyDomain, {
        method: "POST",
        path: `/api/v1/tenant/domains/${id}/verify`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id }
      });
      expect(verified.status).toBe(200);
    }

    // Neither domain has ever been primary yet — both concurrent requests'
    // "unset old primary" UPDATE matches zero rows, so neither blocks the
    // other going into the "set new primary" UPDATE. One must lose to the
    // `awcms_mini_tenant_domains_primary_dedup` unique index.
    const [firstResult, secondResult] = await Promise.all([
      invoke<{ data?: { isPrimary: boolean }; error?: { code: string } }>(
        setPrimaryDomain,
        {
          method: "POST",
          path: `/api/v1/tenant/domains/${first.body.data.id}/set-primary`,
          headers: {
            ...authHeaders(owner),
            "idempotency-key": crypto.randomUUID()
          },
          params: { id: first.body.data.id }
        }
      ),
      invoke<{ data?: { isPrimary: boolean }; error?: { code: string } }>(
        setPrimaryDomain,
        {
          method: "POST",
          path: `/api/v1/tenant/domains/${second.body.data.id}/set-primary`,
          headers: {
            ...authHeaders(owner),
            "idempotency-key": crypto.randomUUID()
          },
          params: { id: second.body.data.id }
        }
      )
    ]);

    const statuses = [firstResult.status, secondResult.status].sort();
    // Exactly one winner (200) and one clean conflict (409) — never a 500,
    // and never both succeeding (which would mean two primaries existed
    // even momentarily).
    expect(statuses).toEqual([200, 409]);

    const loser = firstResult.status === 409 ? firstResult : secondResult;
    expect(loser.body.error?.code).toBe("CONCURRENT_UPDATE");

    const admin = getAdminSql();
    const primaryRows = (await admin`
      SELECT id FROM awcms_mini_tenant_domains
      WHERE tenant_id = ${owner.tenantId} AND is_primary = true AND deleted_at IS NULL
    `) as { id: string }[];

    expect(primaryRows).toHaveLength(1);
  });

  test("set-primary under concurrent SAME Idempotency-Key: exactly one request wins, the loser gets a clean 409 IDEMPOTENCY_CONFLICT (not a raw error), and the mutation never runs twice", async () => {
    const owner = await bootstrap();

    const domain = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const verified = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${domain.body.data.id}/verify`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: domain.body.data.id }
    });
    expect(verified.status).toBe(200);

    const sharedIdempotencyKey = crypto.randomUUID();

    // Same Idempotency-Key sent twice, concurrently — simulates a client
    // network retry racing its own original request. Under READ COMMITTED
    // both requests can pass `findIdempotencyRecord` (no row yet) before
    // either commits; only one can win the
    // `awcms_mini_idempotency_keys_scope_key` unique index.
    const [firstResult, secondResult] = await Promise.all([
      invoke<{ data?: { isPrimary: boolean }; error?: { code: string } }>(
        setPrimaryDomain,
        {
          method: "POST",
          path: `/api/v1/tenant/domains/${domain.body.data.id}/set-primary`,
          headers: {
            ...authHeaders(owner),
            "idempotency-key": sharedIdempotencyKey
          },
          params: { id: domain.body.data.id }
        }
      ),
      invoke<{ data?: { isPrimary: boolean }; error?: { code: string } }>(
        setPrimaryDomain,
        {
          method: "POST",
          path: `/api/v1/tenant/domains/${domain.body.data.id}/set-primary`,
          headers: {
            ...authHeaders(owner),
            "idempotency-key": sharedIdempotencyKey
          },
          params: { id: domain.body.data.id }
        }
      )
    ]);

    const statuses = [firstResult.status, secondResult.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = firstResult.status === 409 ? firstResult : secondResult;
    expect(loser.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

    const admin = getAdminSql();

    // The loser's transaction rolled back — its audit event never persisted,
    // so the mutation ran exactly once despite two concurrent requests.
    const auditRows = (await admin`
      SELECT id FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'tenant_domain.domain.set_primary'
    `) as { id: string }[];
    expect(auditRows).toHaveLength(1);

    const idempotencyRows = (await admin`
      SELECT id FROM awcms_mini_idempotency_keys
      WHERE tenant_id = ${owner.tenantId} AND idempotency_key = ${sharedIdempotencyKey}
    `) as { id: string }[];
    expect(idempotencyRows).toHaveLength(1);
  });
});
