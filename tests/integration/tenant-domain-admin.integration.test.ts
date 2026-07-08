/**
 * Integration tests for the tenant domain admin UI (Issue #563, epic #555,
 * `src/pages/admin/tenant/domains.astro`) against a real PostgreSQL.
 *
 * This page is not rendered through a browser/SSR harness (this repo has no
 * such harness for any `/admin/*` page — see
 * `tests/integration/blog-content-admin-ui.integration.test.ts`, the closest
 * precedent, which exercises the admin-UI-only *data* functions a page reads
 * directly rather than rendering markup). Following that same convention,
 * this file exercises the two things the page's own docblock says it
 * depends on:
 *
 * 1. `listTenantDomains` (`tenant-domain-directory.ts`) — the exact
 *    read-only, direct-DB-call function `domains.astro`'s frontmatter calls
 *    via `withTenant` for its SSR data (see that file's own docblock: "SSR
 *    read is a direct, read-only DB call ... the same convention
 *    `admin/blog/categories.astro` ... use[s]"). Tested here for the shapes
 *    the page's rendering logic branches on — empty state, a freshly
 *    created (`pending_verification`, not primary) domain, and the
 *    post-verify/set-primary shape (`status: "active"`, `isPrimary: true`)
 *    that gates the primary badge and the public `/news` preview link
 *    (`canPreviewNewsLink()` in the page's own frontmatter) — and for tenant
 *    isolation on that exact read path, since the admin page never goes
 *    through an extra ABAC/RLS layer beyond what `withTenant` already
 *    enforces.
 * 2. The real `/api/v1/tenant/domains/**` route handlers (Issue #562) for
 *    the specific error codes the admin page's client-side error-message
 *    catalog (`src/lib/i18n/error-messages.ts`'s `ERROR_CODE_KEYS`,
 *    extended by this issue with `HOSTNAME_CONFLICT`/
 *    `INVALID_STATUS_TRANSITION`/`CONCURRENT_UPDATE`) must be able to map
 *    to a short, safe, human-readable message — proving those mappings are
 *    not dead code for codes the API never actually returns.
 *
 * All mutation coverage for the API itself (CRUD, cross-tenant 404,
 * duplicate-hostname 409, verify/set-primary idempotency + status gating,
 * set-primary atomicity, no `verification_token_hash` leak) already lives in
 * `tenant-domain-api.integration.test.ts` — this file does not repeat that
 * exhaustively, only what is specific to the admin page's own contract.
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
import { POST as createDomain } from "../../src/pages/api/v1/tenant/domains/index";
import { POST as verifyDomain } from "../../src/pages/api/v1/tenant/domains/[id]/verify";
import { POST as setPrimaryDomain } from "../../src/pages/api/v1/tenant/domains/[id]/set-primary";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { listTenantDomains } from "../../src/modules/tenant-domain/application/tenant-domain-directory";
import { ERROR_CODE_KEYS } from "../../src/lib/i18n/error-messages";

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
 * tenant with a real session is provisioned directly, same pattern
 * `tenant-domain-api.integration.test.ts`'s own
 * `provisionSecondTenantWithDomainReadAccess` uses.
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
      VALUES (${tenantId}, ${profile[0]!.id}, 'tenant-b-admin-domain-user@example.com', ${passwordHash})
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
    body: {
      loginIdentifier: "tenant-b-admin-domain-user@example.com",
      password
    },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant domain admin UI data source (Issue #563)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("listTenantDomains: empty for a fresh tenant (SSR empty state)", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const domains = await withTenant(sql, owner.tenantId, (tx) =>
      listTenantDomains(tx, owner.tenantId)
    );

    expect(domains).toEqual([]);
  });

  test("listTenantDomains: freshly created domain is pending_verification, not primary (SSR default row state)", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { hostname: "shop.example.com", domainType: "custom_domain" }
    });
    expect(created.status).toBe(200);

    const sql = getDatabaseClient();
    const domains = await withTenant(sql, owner.tenantId, (tx) =>
      listTenantDomains(tx, owner.tenantId)
    );

    expect(domains).toHaveLength(1);
    expect(domains[0]!.status).toBe("pending_verification");
    expect(domains[0]!.isPrimary).toBe(false);
    expect(domains[0]!.normalizedHostname).toBe("shop.example.com");
    // Never leaks a provider/internal secret field through the SSR read path
    // the admin page uses (Issue #563 §Security notes).
    expect(domains[0]!).not.toHaveProperty("verificationTokenHash");
  });

  test("listTenantDomains: after verify + set-primary, domain is active and primary — the shape the primary badge and /news preview link key off", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: {
        hostname: "shop.example.com",
        domainType: "custom_domain",
        verificationMethod: "manual"
      }
    });
    expect(created.status).toBe(200);
    const domainId = created.body.data.id;

    const verified = await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${domainId}/verify`,
      params: { id: domainId },
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {}
    });
    expect(verified.status).toBe(200);

    const primary = await invoke(setPrimaryDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${domainId}/set-primary`,
      params: { id: domainId },
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {}
    });
    expect(primary.status).toBe(200);

    const sql = getDatabaseClient();
    const domains = await withTenant(sql, owner.tenantId, (tx) =>
      listTenantDomains(tx, owner.tenantId)
    );

    expect(domains).toHaveLength(1);
    expect(domains[0]!.status).toBe("active");
    expect(domains[0]!.isPrimary).toBe(true);
  });

  test("listTenantDomains: tenant isolation on the same direct-read path the admin page uses", async () => {
    const tenantA = await bootstrap();
    const tenantB = await provisionSecondTenantWithDomainReadAccess();

    const created = await invoke(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(tenantA),
      body: { hostname: "tenant-a-only.example.com" }
    });
    expect(created.status).toBe(200);

    const sql = getDatabaseClient();

    const forA = await withTenant(sql, tenantA.tenantId, (tx) =>
      listTenantDomains(tx, tenantA.tenantId)
    );
    expect(forA).toHaveLength(1);
    expect(forA[0]!.normalizedHostname).toBe("tenant-a-only.example.com");

    const forB = await withTenant(sql, tenantB.tenantId, (tx) =>
      listTenantDomains(tx, tenantB.tenantId)
    );
    expect(forB).toEqual([]);
  });

  test("VALIDATION_ERROR: verify without a verification_method configured is mapped by the admin UI's error catalog", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { hostname: "no-verification.example.com" }
    });
    expect(created.status).toBe(200);
    const domainId = created.body.data.id;

    const result = await invoke<{ error: { code: string } }>(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${domainId}/verify`,
      params: { id: domainId },
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {}
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
    expect(ERROR_CODE_KEYS[result.body.error.code]).toBeDefined();
  });

  test("HOSTNAME_CONFLICT: duplicate hostname is a code the admin UI's error catalog maps to a safe message", async () => {
    const owner = await bootstrap();

    const first = await invoke(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { hostname: "dup.example.com" }
    });
    expect(first.status).toBe(200);

    const second = await invoke<{ error: { code: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { hostname: "DUP.example.com" }
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("HOSTNAME_CONFLICT");
    expect(ERROR_CODE_KEYS[second.body.error.code]).toBe(
      "error.hostname_conflict"
    );
  });

  test("INVALID_STATUS_TRANSITION: set-primary on a non-active domain is a code the admin UI's error catalog maps to a safe message", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: { hostname: "not-yet-active.example.com" }
    });
    expect(created.status).toBe(200);
    const domainId = created.body.data.id;

    const result = await invoke<{ error: { code: string } }>(setPrimaryDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${domainId}/set-primary`,
      params: { id: domainId },
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {}
    });

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("INVALID_STATUS_TRANSITION");
    expect(ERROR_CODE_KEYS[result.body.error.code]).toBe(
      "error.invalid_status_transition"
    );
  });

  test("CONCURRENT_UPDATE: set-primary race on a tenant with no existing primary is a code the admin UI's error catalog maps to a safe message", async () => {
    const owner = await bootstrap();

    const first = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: {
        hostname: "race-one.example.com",
        verificationMethod: "manual"
      }
    });
    const second = await invoke<{ data: { id: string } }>(createDomain, {
      method: "POST",
      path: "/api/v1/tenant/domains",
      headers: authHeaders(owner),
      body: {
        hostname: "race-two.example.com",
        verificationMethod: "manual"
      }
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${first.body.data.id}/verify`,
      params: { id: first.body.data.id },
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {}
    });
    await invoke(verifyDomain, {
      method: "POST",
      path: `/api/v1/tenant/domains/${second.body.data.id}/verify`,
      params: { id: second.body.data.id },
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {}
    });

    const [raceA, raceB] = await Promise.all([
      invoke<{ error?: { code: string } }>(setPrimaryDomain, {
        method: "POST",
        path: `/api/v1/tenant/domains/${first.body.data.id}/set-primary`,
        params: { id: first.body.data.id },
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        body: {}
      }),
      invoke<{ error?: { code: string } }>(setPrimaryDomain, {
        method: "POST",
        path: `/api/v1/tenant/domains/${second.body.data.id}/set-primary`,
        params: { id: second.body.data.id },
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        body: {}
      })
    ]);

    const statuses = [raceA.status, raceB.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = raceA.status === 409 ? raceA : raceB;
    expect(conflict.body.error?.code).toBe("CONCURRENT_UPDATE");
    expect(ERROR_CODE_KEYS[conflict.body.error!.code]).toBe(
      "error.concurrent_update"
    );
  });
});
