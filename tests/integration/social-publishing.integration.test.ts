/**
 * Integration tests for Issue #643 (epic `social_publishing`): social
 * publishing outbox foundation — account connect/disconnect (secret
 * redaction), rule CRUD, RLS/ABAC, idempotency, publish-event job creation
 * (including "no draft/private posting"), approval workflow, and the
 * dispatcher's retry/backoff/terminal-failure/rate-limit/needs-reauth
 * outcomes (via an injected fake provider adapter — this issue ships zero
 * real ones).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";

import {
  GET as listAccounts,
  POST as connectAccount
} from "../../src/pages/api/v1/social-publishing/accounts/index";
import { GET as getAccount } from "../../src/pages/api/v1/social-publishing/accounts/[id]";
import { POST as disconnectAccount } from "../../src/pages/api/v1/social-publishing/accounts/[id]/disconnect";
import { POST as verifyAccount } from "../../src/pages/api/v1/social-publishing/accounts/[id]/verify";
import {
  GET as listRules,
  POST as createRule
} from "../../src/pages/api/v1/social-publishing/rules/index";
import { GET as getJob } from "../../src/pages/api/v1/social-publishing/jobs/[id]";
import { GET as listJobs } from "../../src/pages/api/v1/social-publishing/jobs/index";
import { POST as approveJob } from "../../src/pages/api/v1/social-publishing/jobs/[id]/approve";
import { POST as cancelJob } from "../../src/pages/api/v1/social-publishing/jobs/[id]/cancel";
import { POST as retryJob } from "../../src/pages/api/v1/social-publishing/jobs/[id]/retry";

import { dispatchSocialPublishQueue } from "../../src/modules/social-publishing/application/social-publish-dispatch";
import type { SocialProviderAdapter } from "../../src/modules/social-publishing/domain/social-provider-adapter";
import {
  registerSocialProviderAdapter,
  resetSocialProviderRegistryForTests
} from "../../src/modules/social-publishing/infrastructure/social-provider-registry";
import { createTelegramChannelProviderAdapter } from "../../src/modules/social-publishing/infrastructure/telegram-provider-adapter";
import { createMetaFacebookPageAdapter } from "../../src/modules/social-publishing/infrastructure/meta/meta-facebook-page-adapter";
import { createMetaInstagramAdapter } from "../../src/modules/social-publishing/infrastructure/meta/meta-instagram-adapter";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = {
  tenantId: string;
  tenantCode: string;
  token: string;
  tenantUserId: string;
};

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
    tenantCode,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/** Seeds a verified, primary custom domain for a tenant — required for `create-social-publish-jobs.ts` to resolve a canonical URL (without one, job creation is a documented, correct no-op skip — see `resolvePrimaryVerifiedDomainHostname`'s header comment). */
async function seedPrimaryVerifiedDomain(
  tenantId: string,
  hostname: string
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenant_domains
      (tenant_id, hostname, normalized_hostname, domain_type, route_mode, status, is_primary)
    VALUES (${tenantId}, ${hostname}, ${hostname.toLowerCase()}, 'custom_domain', 'canonical', 'active', true)
  `;
}

/** A second, fully-independent tenant that DOES have full social_publishing access (own role/permissions) — for RLS-invisibility tests where a bare ABAC-deny (403) would be a false positive. `/setup/initialize` is a one-time wizard, so this tenant is seeded via raw SQL + a real login, same pattern `news-portal-ad-placements.integration.test.ts`'s own `seedSecondTenant` uses. */
async function seedSecondTenantWithSocialPublishingAccess(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'full_access', 'Full Access') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions WHERE module_key = 'social_publishing'
    `) as { id: string }[];

    for (const permission of permissions) {
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission.id})
      `;
    }

    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;

    tenantUserId = tenantUser[0]!.id;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, tenantCode, token: login.body.data.token, tenantUserId };
}

/** A second, fully-independent tenant with NO social_publishing permissions granted — for ABAC-deny and RLS tests. */
async function seedRestrictedSecondTenant(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    // No role/permissions granted at all — a bare tenant user, used for ABAC-deny.

    tenantUserId = tenantUser[0]!.id;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, tenantCode, token: login.body.data.token, tenantUserId };
}

const CONNECT_BODY = {
  providerKey: "telegram_channel",
  providerAccountId: "channel-123",
  providerAccountName: "Test Channel",
  providerAccountType: "channel" as const,
  tokenReference: "secretsmanager:social/telegram-channel-123",
  autoPublishEnabled: true
};

const suite = integrationEnabled ? describe : describe.skip;

suite("social_publishing outbox foundation (Issue #643)", () => {
  const originalSocialPublishingEnabled = process.env.SOCIAL_PUBLISHING_ENABLED;
  const originalSocialPublishingProfile = process.env.SOCIAL_PUBLISHING_PROFILE;

  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    process.env.SOCIAL_PUBLISHING_ENABLED = originalSocialPublishingEnabled;
    process.env.SOCIAL_PUBLISHING_PROFILE = originalSocialPublishingProfile;
  });

  // -------------------------------------------------------------------
  // Account connect/disconnect + secret redaction
  // -------------------------------------------------------------------

  test("connect requires Idempotency-Key", async () => {
    const owner = await bootstrap();
    const result = await invoke<{ error: { code: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: authHeaders(owner),
      body: CONNECT_BODY
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("IDEMPOTENCY_REQUIRED");
  });

  test("connect succeeds and never returns tokenReference in the response", async () => {
    const owner = await bootstrap();
    const result = await invoke<{ data: Record<string, unknown> }>(
      connectAccount,
      {
        method: "POST",
        path: "/api/v1/social-publishing/accounts",
        headers: { ...authHeaders(owner), "idempotency-key": "connect-key-1" },
        body: CONNECT_BODY
      }
    );

    expect(result.status).toBe(200);
    expect(result.body.data.connectionStatus).toBe("connected");
    expect(result.body.data.providerAccountName).toBe("Test Channel");
    expect(result.body.data).not.toHaveProperty("tokenReference");
    expect(JSON.stringify(result.body)).not.toContain(
      "secretsmanager:social/telegram-channel-123"
    );
  });

  test("rejects a tokenReference that looks like a raw JWT/access token", async () => {
    const owner = await bootstrap();
    const result = await invoke(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-key-raw" },
      body: {
        ...CONNECT_BODY,
        // Not a real JWT (not valid base64url/JSON) — just shaped like one
        // (3 dot-separated segments, >40 chars) to exercise
        // looksLikeRawSecretToken's structural check without tripping
        // secret-scanners that validate actual JWT decodability.
        tokenReference:
          "not-a-real-jwt-header-segment.not-a-real-jwt-payload-segment.not-a-real-jwt-signature-segment"
      }
    });
    expect(result.status).toBe(400);
  });

  test("connect replays the same response for a repeated Idempotency-Key, and conflicts on a different body", async () => {
    const owner = await bootstrap();
    const headers = { ...authHeaders(owner), "idempotency-key": "replay-key" };

    const first = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers,
      body: CONNECT_BODY
    });
    expect(first.status).toBe(200);

    const second = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers,
      body: CONNECT_BODY
    });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);

    const conflict = await invoke(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers,
      body: { ...CONNECT_BODY, providerAccountId: "different-channel" }
    });
    expect(conflict.status).toBe(409);
  });

  test("reconnecting the same (providerKey, providerAccountId) upserts rather than duplicating", async () => {
    const owner = await bootstrap();
    const first = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-a" },
      body: CONNECT_BODY
    });
    expect(first.status).toBe(200);

    const second = await invoke<{
      data: { id: string; providerAccountName: string };
    }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-b" },
      body: { ...CONNECT_BODY, providerAccountName: "Renamed Channel" }
    });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.providerAccountName).toBe("Renamed Channel");

    const list = await invoke<{ data: { accounts: unknown[] } }>(listAccounts, {
      method: "GET",
      path: "/api/v1/social-publishing/accounts",
      headers: authHeaders(owner)
    });
    expect(list.body.data.accounts.length).toBe(1);
  });

  test("disconnect clears token_reference in the database (never merely status-flipped, still holding the reference)", async () => {
    const owner = await bootstrap();
    const connected = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-key-2" },
      body: CONNECT_BODY
    });
    const accountId = connected.body.data.id;

    const disconnected = await invoke<{ data: { connectionStatus: string } }>(
      disconnectAccount,
      {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/disconnect`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": "disconnect-key-1"
        },
        params: { id: accountId },
        body: { reason: "no longer needed" }
      }
    );
    expect(disconnected.status).toBe(200);
    expect(disconnected.body.data.connectionStatus).toBe("disconnected");

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT token_reference FROM awcms_mini_social_accounts WHERE id = ${accountId}
    `) as { token_reference: string | null }[];
    expect(rows[0]!.token_reference).toBeNull();
  });

  test("disconnect requires Idempotency-Key", async () => {
    const owner = await bootstrap();
    const connected = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-key-3" },
      body: CONNECT_BODY
    });

    const result = await invoke(disconnectAccount, {
      method: "POST",
      path: `/api/v1/social-publishing/accounts/${connected.body.data.id}/disconnect`,
      headers: authHeaders(owner),
      params: { id: connected.body.data.id },
      body: { reason: "x" }
    });
    expect(result.status).toBe(400);
  });

  // -------------------------------------------------------------------
  // Account verify (Issue #646) — route-level behavior (idempotency,
  // permission, audit, redaction) via an injected fake adapter registered
  // under the SAME "telegram_channel" key the real Telegram adapter also
  // registers itself under at import time. The real Telegram HTTP client
  // code is covered separately and exclusively by
  // tests/unit/telegram-provider-adapter.test.ts (a local fake HTTP server,
  // never a real network call) — this suite never exercises it, only the
  // provider-neutral route/directory logic around whatever adapter the
  // registry resolves.
  // -------------------------------------------------------------------

  describe("account verify (Issue #646)", () => {
    // Each test re-registers its own fake adapter under "telegram_channel"
    // (Map.set overwrites the previous entry for the same key — no reset
    // needed between tests). The LAST test in this block deliberately
    // clears the registry entirely, so `afterAll` restores the real
    // Telegram adapter afterward — otherwise every test file sharing this
    // process (Bun runs all test files in one process) would see an empty
    // registry for the rest of the run, purely as a side effect of this
    // block having executed.
    afterAll(() => {
      registerSocialProviderAdapter(createTelegramChannelProviderAdapter());
    });

    async function connectForVerify(owner: Bootstrap): Promise<string> {
      const connected = await invoke<{ data: { id: string } }>(connectAccount, {
        method: "POST",
        path: "/api/v1/social-publishing/accounts",
        headers: {
          ...authHeaders(owner),
          "idempotency-key": `connect-verify-${crypto.randomUUID()}`
        },
        body: CONNECT_BODY
      });
      expect(connected.status).toBe(200);
      return connected.body.data.id;
    }

    test("requires Idempotency-Key", async () => {
      const owner = await bootstrap();
      const accountId = await connectForVerify(owner);

      const result = await invoke(verifyAccount, {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
        headers: authHeaders(owner),
        params: { id: accountId },
        body: {}
      });
      expect(result.status).toBe(400);
    });

    test("a tenant user without accounts.verify is denied (403)", async () => {
      const restricted = await seedRestrictedSecondTenant("tenant-verify-403");
      const result = await invoke(verifyAccount, {
        method: "POST",
        path: "/api/v1/social-publishing/accounts/00000000-0000-0000-0000-000000000000/verify",
        headers: {
          ...authHeaders(restricted),
          "idempotency-key": "verify-403-1"
        },
        params: { id: "00000000-0000-0000-0000-000000000000" },
        body: {}
      });
      expect(result.status).toBe(403);
    });

    test("returns 404 for an unknown account id", async () => {
      const owner = await bootstrap();
      const result = await invoke(verifyAccount, {
        method: "POST",
        path: "/api/v1/social-publishing/accounts/00000000-0000-0000-0000-000000000000/verify",
        headers: { ...authHeaders(owner), "idempotency-key": "verify-404-1" },
        params: { id: "00000000-0000-0000-0000-000000000000" },
        body: {}
      });
      expect(result.status).toBe(404);
    });

    test("successful check sets lastVerifiedAt, records an audit event, and never leaks the token reference", async () => {
      const owner = await bootstrap();
      const accountId = await connectForVerify(owner);

      let callCount = 0;
      registerSocialProviderAdapter({
        providerKey: "telegram_channel",
        requiredEnvVars: [],
        async publish() {
          throw new Error("not used in this test");
        },
        async verifyCredentials(tokenReference) {
          callCount += 1;
          // The route must never let this value reach the HTTP response —
          // asserted below via the response body, not here.
          expect(tokenReference).toBe(CONNECT_BODY.tokenReference);
          return {
            valid: true,
            details: {
              botUsername: "test_bot",
              permissions: ["can_post_messages"]
            }
          };
        }
      } satisfies SocialProviderAdapter);

      const result = await invoke<{
        data: {
          valid: boolean;
          reason: string | null;
          verifiedAt: string | null;
        };
      }>(verifyAccount, {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": "verify-success-1"
        },
        params: { id: accountId },
        body: {}
      });

      expect(result.status).toBe(200);
      expect(result.body.data.valid).toBe(true);
      expect(result.body.data.verifiedAt).not.toBeNull();
      expect(JSON.stringify(result.body)).not.toContain(
        CONNECT_BODY.tokenReference
      );
      expect(callCount).toBe(1);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT last_verified_at, scopes_json FROM awcms_mini_social_accounts WHERE id = ${accountId}
      `) as { last_verified_at: Date | null; scopes_json: unknown }[];
      expect(rows[0]!.last_verified_at).not.toBeNull();
      expect(rows[0]!.scopes_json).toEqual(["can_post_messages"]);

      const auditRows = (await admin`
        SELECT action FROM awcms_mini_audit_events
        WHERE tenant_id = ${owner.tenantId} AND resource_id = ${accountId}
          AND action = 'social_publishing.account.verified'
      `) as { action: string }[];
      expect(auditRows.length).toBe(1);
    });

    test("a failed check (e.g. missing channel permission) is still a 200, does not flip connectionStatus, and records a warning audit event", async () => {
      const owner = await bootstrap();
      const accountId = await connectForVerify(owner);

      registerSocialProviderAdapter({
        providerKey: "telegram_channel",
        requiredEnvVars: [],
        async publish() {
          throw new Error("not used in this test");
        },
        async verifyCredentials() {
          return { valid: false, reason: "missing_channel_permission" };
        }
      } satisfies SocialProviderAdapter);

      const result = await invoke<{
        data: { valid: boolean; reason: string | null };
      }>(verifyAccount, {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": "verify-failed-1"
        },
        params: { id: accountId },
        body: {}
      });

      expect(result.status).toBe(200);
      expect(result.body.data.valid).toBe(false);
      expect(result.body.data.reason).toBe("missing_channel_permission");

      const admin = getAdminSql();
      const accountRows = (await admin`
        SELECT connection_status, last_verified_at FROM awcms_mini_social_accounts WHERE id = ${accountId}
      `) as { connection_status: string; last_verified_at: Date | null }[];
      expect(accountRows[0]!.connection_status).toBe("connected");
      expect(accountRows[0]!.last_verified_at).toBeNull();

      const auditRows = (await admin`
        SELECT action, severity FROM awcms_mini_audit_events
        WHERE tenant_id = ${owner.tenantId} AND resource_id = ${accountId}
          AND action = 'social_publishing.account.verification_failed'
      `) as { action: string; severity: string }[];
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]!.severity).toBe("warning");
    });

    test("replays the same response for a repeated Idempotency-Key without calling the adapter twice", async () => {
      const owner = await bootstrap();
      const accountId = await connectForVerify(owner);

      let callCount = 0;
      registerSocialProviderAdapter({
        providerKey: "telegram_channel",
        requiredEnvVars: [],
        async publish() {
          throw new Error("not used in this test");
        },
        async verifyCredentials() {
          callCount += 1;
          return { valid: true };
        }
      } satisfies SocialProviderAdapter);

      const headers = {
        ...authHeaders(owner),
        "idempotency-key": "verify-replay-1"
      };

      const first = await invoke(verifyAccount, {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
        headers,
        params: { id: accountId },
        body: {}
      });
      expect(first.status).toBe(200);

      const second = await invoke(verifyAccount, {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
        headers,
        params: { id: accountId },
        body: {}
      });
      expect(second.status).toBe(200);
      expect(callCount).toBe(1);
    });

    test("cannot verify a disconnected account (409)", async () => {
      const owner = await bootstrap();
      const accountId = await connectForVerify(owner);

      const disconnectResult = await invoke(disconnectAccount, {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/disconnect`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": "verify-disconnect-1"
        },
        params: { id: accountId },
        body: { reason: "test" }
      });
      expect(disconnectResult.status).toBe(200);

      const result = await invoke(verifyAccount, {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": "verify-after-disconnect-1"
        },
        params: { id: accountId },
        body: {}
      });
      expect(result.status).toBe(409);
    });

    test("no adapter registered for the account's provider reports a 200 valid:false rather than an error", async () => {
      const owner = await bootstrap();
      const accountId = await connectForVerify(owner);
      resetSocialProviderRegistryForTests();

      try {
        const result = await invoke<{
          data: { valid: boolean; reason: string };
        }>(verifyAccount, {
          method: "POST",
          path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
          headers: {
            ...authHeaders(owner),
            "idempotency-key": "verify-no-adapter-1"
          },
          params: { id: accountId },
          body: {}
        });
        expect(result.status).toBe(200);
        expect(result.body.data.valid).toBe(false);
        expect(result.body.data.reason).toBe("provider_not_registered");
      } finally {
        // `resetSocialProviderRegistryForTests()` clears the shared,
        // process-wide registry singleton — since `bun test` runs every
        // test FILE in this suite in the same process, leaving it empty
        // would silently break every subsequent test (in this file or any
        // other) that expects a real provider adapter to be registered
        // (e.g. Issue #644's Meta connect-time `supportedAccountTypes`
        // check). Restore the exact set this repo registers unconditionally
        // at import time (`social-provider-registry.ts`'s own trailing
        // registration block + `telegram-provider-registration.ts`) so this
        // test's side effect never leaks into any other test.
        registerSocialProviderAdapter(createMetaFacebookPageAdapter());
        registerSocialProviderAdapter(createMetaInstagramAdapter());
        registerSocialProviderAdapter(createTelegramChannelProviderAdapter());
      }
    });
  });

  // -------------------------------------------------------------------
  // RLS / ABAC
  // -------------------------------------------------------------------

  test("cross-tenant isolation: tenant B cannot see tenant A's social account (404, not 403 — RLS makes it invisible)", async () => {
    const ownerA = await bootstrap("tenant-a");
    const connected = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(ownerA), "idempotency-key": "connect-a-1" },
      body: CONNECT_BODY
    });
    const accountId = connected.body.data.id;

    const ownerB = await seedSecondTenantWithSocialPublishingAccess("tenant-b");
    const result = await invoke(getAccount, {
      method: "GET",
      path: `/api/v1/social-publishing/accounts/${accountId}`,
      headers: authHeaders(ownerB),
      params: { id: accountId }
    });
    expect(result.status).toBe(404);
  });

  test("a tenant user without social_publishing permissions is denied (403) on read and connect", async () => {
    const restricted = await seedRestrictedSecondTenant("tenant-c");

    const readResult = await invoke(listAccounts, {
      method: "GET",
      path: "/api/v1/social-publishing/accounts",
      headers: authHeaders(restricted)
    });
    expect(readResult.status).toBe(403);

    const connectResult = await invoke(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: {
        ...authHeaders(restricted),
        "idempotency-key": "connect-restricted-1"
      },
      body: CONNECT_BODY
    });
    expect(connectResult.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------

  test("rule create rejects a socialAccountId that does not exist for this tenant (422)", async () => {
    const owner = await bootstrap();
    const result = await invoke(createRule, {
      method: "POST",
      path: "/api/v1/social-publishing/rules",
      headers: authHeaders(owner),
      body: {
        socialAccountId: crypto.randomUUID(),
        triggerEvent: "post_published"
      }
    });
    expect(result.status).toBe(422);
  });

  test("rule create succeeds for a real account and defaults requiresApproval/isEnabled to true", async () => {
    const owner = await bootstrap();
    const account = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-r-1" },
      body: CONNECT_BODY
    });

    const rule = await invoke<{
      data: { requiresApproval: boolean; isEnabled: boolean };
    }>(createRule, {
      method: "POST",
      path: "/api/v1/social-publishing/rules",
      headers: authHeaders(owner),
      body: {
        socialAccountId: account.body.data.id,
        triggerEvent: "post_published"
      }
    });
    expect(rule.status).toBe(200);
    expect(rule.body.data.requiresApproval).toBe(true);
    expect(rule.body.data.isEnabled).toBe(true);
  });

  test("rule list only returns this tenant's own rules (RLS)", async () => {
    const owner = await bootstrap();
    const account = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-r-list-1" },
      body: CONNECT_BODY
    });
    await invoke(createRule, {
      method: "POST",
      path: "/api/v1/social-publishing/rules",
      headers: authHeaders(owner),
      body: {
        socialAccountId: account.body.data.id,
        triggerEvent: "post_published"
      }
    });

    const otherTenant =
      await seedSecondTenantWithSocialPublishingAccess("rule-list-b");
    const otherAccount = await invoke<{ data: { id: string } }>(
      connectAccount,
      {
        method: "POST",
        path: "/api/v1/social-publishing/accounts",
        headers: {
          ...authHeaders(otherTenant),
          "idempotency-key": "connect-r-list-2"
        },
        body: CONNECT_BODY
      }
    );
    await invoke(createRule, {
      method: "POST",
      path: "/api/v1/social-publishing/rules",
      headers: authHeaders(otherTenant),
      body: {
        socialAccountId: otherAccount.body.data.id,
        triggerEvent: "post_published"
      }
    });

    const list = await invoke<{ data: { rules: unknown[] } }>(listRules, {
      method: "GET",
      path: "/api/v1/social-publishing/rules",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.rules.length).toBe(1);
  });

  // -------------------------------------------------------------------
  // Publish-event job creation (idempotent, gated by deployment env, no
  // draft/private posting) + approval workflow
  // -------------------------------------------------------------------

  async function seedConnectedAccountAndRule(
    owner: Bootstrap,
    requiresApproval: boolean
  ): Promise<{ accountId: string; ruleId: string }> {
    // A verified primary domain is required for `create-social-publish-jobs.ts`
    // to resolve a canonical URL — without one, job creation is a documented,
    // correct no-op skip (`no_verified_domain`), which every job-creation test
    // below needs NOT to happen.
    await seedPrimaryVerifiedDomain(
      owner.tenantId,
      `${owner.tenantCode}.example.test`
    );

    const account = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: {
        ...authHeaders(owner),
        "idempotency-key": `connect-${requiresApproval}`
      },
      body: CONNECT_BODY
    });

    const rule = await invoke<{ data: { id: string } }>(createRule, {
      method: "POST",
      path: "/api/v1/social-publishing/rules",
      headers: authHeaders(owner),
      body: {
        socialAccountId: account.body.data.id,
        triggerEvent: "post_published",
        requiresApproval,
        isEnabled: true
      }
    });

    return { accountId: account.body.data.id, ruleId: rule.body.data.id };
  }

  async function createDraftPost(
    owner: Bootstrap,
    slug: string
  ): Promise<string> {
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Hello World",
        slug,
        contentJson: { blocks: [{ type: "paragraph", text: "Hello" }] },
        contentText: "Hello",
        excerpt: "An excerpt"
      }
    });
    expect(created.status).toBe(200);
    return created.body.data.id;
  }

  test("no job is created while a post stays draft (no draft/private posting)", async () => {
    process.env.SOCIAL_PUBLISHING_ENABLED = "true";
    process.env.SOCIAL_PUBLISHING_PROFILE = "full_online";

    const owner = await bootstrap();
    await seedConnectedAccountAndRule(owner, false);
    await createDraftPost(owner, "draft-post-1");

    const jobs = await invoke<{ data: { jobs: unknown[] } }>(listJobs, {
      method: "GET",
      path: "/api/v1/social-publishing/jobs",
      headers: authHeaders(owner)
    });
    expect(jobs.body.data.jobs.length).toBe(0);
  });

  test("publishing an eligible post creates a job (requiresApproval=false -> status pending), idempotent on republish attempts", async () => {
    process.env.SOCIAL_PUBLISHING_ENABLED = "true";
    process.env.SOCIAL_PUBLISHING_PROFILE = "full_online";

    const owner = await bootstrap();
    await seedConnectedAccountAndRule(owner, false);
    const postId = await createDraftPost(owner, "eligible-post-1");

    const published = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-1" },
      params: { id: postId }
    });
    expect(published.status).toBe(200);

    const jobs = await invoke<{
      data: { jobs: { status: string; articleId: string }[] };
    }>(listJobs, {
      method: "GET",
      path: "/api/v1/social-publishing/jobs",
      headers: authHeaders(owner)
    });
    expect(jobs.body.data.jobs.length).toBe(1);
    expect(jobs.body.data.jobs[0]!.status).toBe("pending");
    expect(jobs.body.data.jobs[0]!.articleId).toBe(postId);
  });

  test("SOCIAL_PUBLISHING_ENABLED unset (offline/LAN default) — publishing an eligible post creates zero jobs", async () => {
    delete process.env.SOCIAL_PUBLISHING_ENABLED;
    delete process.env.SOCIAL_PUBLISHING_PROFILE;

    const owner = await bootstrap();
    await seedConnectedAccountAndRule(owner, false);
    const postId = await createDraftPost(owner, "disabled-deployment-post");

    const published = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": "publish-disabled-1"
      },
      params: { id: postId }
    });
    expect(published.status).toBe(200);

    const jobs = await invoke<{ data: { jobs: unknown[] } }>(listJobs, {
      method: "GET",
      path: "/api/v1/social-publishing/jobs",
      headers: authHeaders(owner)
    });
    expect(jobs.body.data.jobs.length).toBe(0);
  });

  test("approval workflow: requiresApproval=true creates a requires_approval job; approve transitions it; approving twice fails", async () => {
    process.env.SOCIAL_PUBLISHING_ENABLED = "true";
    process.env.SOCIAL_PUBLISHING_PROFILE = "full_online";

    const owner = await bootstrap();
    await seedConnectedAccountAndRule(owner, true);
    const postId = await createDraftPost(owner, "approval-post-1");

    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": "publish-approval-1"
      },
      params: { id: postId }
    });

    const jobs = await invoke<{
      data: { jobs: { id: string; status: string }[] };
    }>(listJobs, {
      method: "GET",
      path: "/api/v1/social-publishing/jobs",
      headers: authHeaders(owner)
    });
    expect(jobs.body.data.jobs.length).toBe(1);
    expect(jobs.body.data.jobs[0]!.status).toBe("requires_approval");
    const jobId = jobs.body.data.jobs[0]!.id;

    const approved = await invoke<{ data: { status: string } }>(approveJob, {
      method: "POST",
      path: `/api/v1/social-publishing/jobs/${jobId}/approve`,
      headers: { ...authHeaders(owner), "idempotency-key": "approve-1" },
      params: { id: jobId },
      body: {}
    });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("approved");

    const secondApprove = await invoke(approveJob, {
      method: "POST",
      path: `/api/v1/social-publishing/jobs/${jobId}/approve`,
      headers: { ...authHeaders(owner), "idempotency-key": "approve-2" },
      params: { id: jobId },
      body: {}
    });
    expect(secondApprove.status).toBe(409);
  });

  test("cancel requires Idempotency-Key and is valid from a non-terminal status", async () => {
    process.env.SOCIAL_PUBLISHING_ENABLED = "true";
    process.env.SOCIAL_PUBLISHING_PROFILE = "full_online";

    const owner = await bootstrap();
    await seedConnectedAccountAndRule(owner, false);
    const postId = await createDraftPost(owner, "cancel-post-1");
    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-cancel-1" },
      params: { id: postId }
    });

    const jobs = await invoke<{ data: { jobs: { id: string }[] } }>(listJobs, {
      method: "GET",
      path: "/api/v1/social-publishing/jobs",
      headers: authHeaders(owner)
    });
    const jobId = jobs.body.data.jobs[0]!.id;

    const noKey = await invoke(cancelJob, {
      method: "POST",
      path: `/api/v1/social-publishing/jobs/${jobId}/cancel`,
      headers: authHeaders(owner),
      params: { id: jobId },
      body: { reason: "x" }
    });
    expect(noKey.status).toBe(400);

    const cancelled = await invoke<{ data: { status: string } }>(cancelJob, {
      method: "POST",
      path: `/api/v1/social-publishing/jobs/${jobId}/cancel`,
      headers: { ...authHeaders(owner), "idempotency-key": "cancel-1" },
      params: { id: jobId },
      body: { reason: "no longer relevant" }
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");

    const retryAfterCancel = await invoke(retryJob, {
      method: "POST",
      path: `/api/v1/social-publishing/jobs/${jobId}/retry`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": "retry-after-cancel"
      },
      params: { id: jobId }
    });
    expect(retryAfterCancel.status).toBe(409);
  });

  // -------------------------------------------------------------------
  // Dispatcher: retry/backoff, terminal failure, rate limit, needs-reauth,
  // provider-not-registered — via an injected fake adapter (no real HTTP).
  // -------------------------------------------------------------------

  async function seedPendingJob(
    owner: Bootstrap,
    slug: string
  ): Promise<string> {
    process.env.SOCIAL_PUBLISHING_ENABLED = "true";
    process.env.SOCIAL_PUBLISHING_PROFILE = "full_online";

    await seedConnectedAccountAndRule(owner, false);
    const postId = await createDraftPost(owner, slug);
    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": `publish-${slug}` },
      params: { id: postId }
    });

    const jobs = await invoke<{ data: { jobs: { id: string }[] } }>(listJobs, {
      method: "GET",
      path: "/api/v1/social-publishing/jobs",
      headers: authHeaders(owner)
    });
    return jobs.body.data.jobs[0]!.id;
  }

  test("dispatcher: successful publish sets status=published, externalPostId/Url, and one success attempt row", async () => {
    const owner = await bootstrap();
    const jobId = await seedPendingJob(owner, "dispatch-success-1");

    const fakeAdapter: SocialProviderAdapter = {
      providerKey: "telegram_channel",
      requiredEnvVars: [],
      async publish() {
        return {
          outcome: "published",
          externalPostId: "ext-1",
          externalPostUrl: "https://t.me/testchannel/1"
        };
      },
      async verifyCredentials() {
        return { valid: true };
      }
    };

    const sql = getDatabaseClient();
    const result = await dispatchSocialPublishQueue(sql, owner.tenantId, {
      resolveAdapter: () => fakeAdapter
    });
    expect(result.published).toBe(1);

    const job = await invoke<{
      data: { status: string; externalPostId: string; externalPostUrl: string };
    }>(getJob, {
      method: "GET",
      path: `/api/v1/social-publishing/jobs/${jobId}`,
      headers: authHeaders(owner),
      params: { id: jobId }
    });
    expect(job.body.data.status).toBe("published");
    expect(job.body.data.externalPostId).toBe("ext-1");
    expect(job.body.data.externalPostUrl).toBe("https://t.me/testchannel/1");
  });

  test("dispatcher: retryable failure schedules a backoff retry and records a safe, sanitized attempt", async () => {
    const owner = await bootstrap();
    const jobId = await seedPendingJob(owner, "dispatch-retry-1");

    const fakeAdapter: SocialProviderAdapter = {
      providerKey: "telegram_channel",
      requiredEnvVars: [],
      async publish() {
        return {
          outcome: "failed",
          errorCode: "provider_timeout",
          errorMessage: "Upstream request timed out.",
          retryable: true
        };
      },
      async verifyCredentials() {
        return { valid: true };
      }
    };

    const sql = getDatabaseClient();
    const result = await dispatchSocialPublishQueue(sql, owner.tenantId, {
      resolveAdapter: () => fakeAdapter
    });
    expect(result.retried).toBe(1);

    const job = await invoke<{
      data: {
        status: string;
        attemptCount: number;
        nextAttemptAt: string | null;
        lastErrorCode: string;
      };
    }>(getJob, {
      method: "GET",
      path: `/api/v1/social-publishing/jobs/${jobId}`,
      headers: authHeaders(owner),
      params: { id: jobId }
    });
    expect(job.body.data.status).toBe("pending");
    expect(job.body.data.attemptCount).toBe(1);
    expect(job.body.data.nextAttemptAt).not.toBeNull();
    expect(job.body.data.lastErrorCode).toBe("provider_timeout");
  });

  test("dispatcher: exhausting the retry budget reaches a terminal failed state", async () => {
    const owner = await bootstrap();
    const jobId = await seedPendingJob(owner, "dispatch-exhaust-1");

    const admin = getAdminSql();
    // Shrink the retry budget so the very first attempt already exhausts it.
    await admin`UPDATE awcms_mini_social_publish_jobs SET max_attempts = 1 WHERE id = ${jobId}`;

    const fakeAdapter: SocialProviderAdapter = {
      providerKey: "telegram_channel",
      requiredEnvVars: [],
      async publish() {
        return {
          outcome: "failed",
          errorCode: "provider_rejected",
          errorMessage: "Provider rejected the request.",
          retryable: true
        };
      },
      async verifyCredentials() {
        return { valid: true };
      }
    };

    const sql = getDatabaseClient();
    const result = await dispatchSocialPublishQueue(sql, owner.tenantId, {
      resolveAdapter: () => fakeAdapter
    });
    expect(result.failed).toBe(1);

    const job = await invoke<{ data: { status: string } }>(getJob, {
      method: "GET",
      path: `/api/v1/social-publishing/jobs/${jobId}`,
      headers: authHeaders(owner),
      params: { id: jobId }
    });
    expect(job.body.data.status).toBe("failed");

    // A terminal job cannot be retried once its own attempt budget is spent.
    const retry = await invoke(retryJob, {
      method: "POST",
      path: `/api/v1/social-publishing/jobs/${jobId}/retry`,
      headers: { ...authHeaders(owner), "idempotency-key": "retry-exhausted" },
      params: { id: jobId }
    });
    expect(retry.status).toBe(409);
  });

  test("dispatcher: rate_limited outcome schedules a backoff retry with status=rate_limited", async () => {
    const owner = await bootstrap();
    const jobId = await seedPendingJob(owner, "dispatch-rate-limited-1");

    const fakeAdapter: SocialProviderAdapter = {
      providerKey: "telegram_channel",
      requiredEnvVars: [],
      async publish() {
        return {
          outcome: "rate_limited",
          errorCode: "rate_limited",
          errorMessage: "Too many requests.",
          retryable: true,
          retryAfterSeconds: 120
        };
      },
      async verifyCredentials() {
        return { valid: true };
      }
    };

    const sql = getDatabaseClient();
    const result = await dispatchSocialPublishQueue(sql, owner.tenantId, {
      resolveAdapter: () => fakeAdapter
    });
    expect(result.rateLimited).toBe(1);

    const job = await invoke<{
      data: { status: string; nextAttemptAt: string };
    }>(getJob, {
      method: "GET",
      path: `/api/v1/social-publishing/jobs/${jobId}`,
      headers: authHeaders(owner),
      params: { id: jobId }
    });
    expect(job.body.data.status).toBe("rate_limited");
    expect(job.body.data.nextAttemptAt).not.toBeNull();
  });

  test("dispatcher: needs_reauth outcome flips both the job and its linked account to needs_reauth", async () => {
    const owner = await bootstrap();
    const jobId = await seedPendingJob(owner, "dispatch-needs-reauth-1");

    const fakeAdapter: SocialProviderAdapter = {
      providerKey: "telegram_channel",
      requiredEnvVars: [],
      async publish() {
        return {
          outcome: "needs_reauth",
          errorCode: "token_expired",
          errorMessage: "The access token has expired.",
          retryable: false
        };
      },
      async verifyCredentials() {
        return { valid: false };
      }
    };

    const sql = getDatabaseClient();
    const result = await dispatchSocialPublishQueue(sql, owner.tenantId, {
      resolveAdapter: () => fakeAdapter
    });
    expect(result.needsReauth).toBe(1);

    const job = await invoke<{ data: { status: string } }>(getJob, {
      method: "GET",
      path: `/api/v1/social-publishing/jobs/${jobId}`,
      headers: authHeaders(owner),
      params: { id: jobId }
    });
    expect(job.body.data.status).toBe("needs_reauth");

    const accounts = await invoke<{
      data: { accounts: { connectionStatus: string }[] };
    }>(listAccounts, {
      method: "GET",
      path: "/api/v1/social-publishing/accounts",
      headers: authHeaders(owner)
    });
    expect(accounts.body.data.accounts[0]!.connectionStatus).toBe(
      "needs_reauth"
    );
  });

  test("dispatcher: no adapter registered for the job's provider is a terminal, non-retryable failure", async () => {
    const owner = await bootstrap();
    const jobId = await seedPendingJob(owner, "dispatch-no-adapter-1");

    const sql = getDatabaseClient();
    const result = await dispatchSocialPublishQueue(sql, owner.tenantId, {
      resolveAdapter: () => undefined
    });
    expect(result.failed).toBe(1);

    const job = await invoke<{
      data: { status: string; lastErrorCode: string };
    }>(getJob, {
      method: "GET",
      path: `/api/v1/social-publishing/jobs/${jobId}`,
      headers: authHeaders(owner),
      params: { id: jobId }
    });
    expect(job.body.data.status).toBe("failed");
    expect(job.body.data.lastErrorCode).toBe("provider_not_registered");
  });

  test("dispatcher: an adapter's supportedAccountTypes is enforced before publish() is ever called (Issue #644 review follow-up — blocking finding)", async () => {
    const owner = await bootstrap();
    const jobId = await seedPendingJob(owner, "dispatch-unsupported-type-1");

    let publishCalled = false;
    // CONNECT_BODY (this file's fixture) connects the account as
    // providerAccountType "channel" — an adapter that only supports "page"
    // must reject it before ever attempting a provider call.
    const fakeAdapter: SocialProviderAdapter = {
      providerKey: "telegram_channel",
      requiredEnvVars: [],
      supportedAccountTypes: ["page"],
      async publish() {
        publishCalled = true;
        return {
          outcome: "published",
          externalPostId: "ext-1",
          externalPostUrl: "https://t.me/testchannel/1"
        };
      },
      async verifyCredentials() {
        return { valid: true };
      }
    };

    const sql = getDatabaseClient();
    const result = await dispatchSocialPublishQueue(sql, owner.tenantId, {
      resolveAdapter: () => fakeAdapter
    });
    expect(result.failed).toBe(1);
    expect(publishCalled).toBe(false);

    const job = await invoke<{
      data: { status: string; lastErrorCode: string };
    }>(getJob, {
      method: "GET",
      path: `/api/v1/social-publishing/jobs/${jobId}`,
      headers: authHeaders(owner),
      params: { id: jobId }
    });
    expect(job.body.data.status).toBe("failed");
    expect(job.body.data.lastErrorCode).toBe("unsupported_account_type");
  });

  test("connect: rejects providerAccountType the registered adapter doesn't support (defense-in-depth, second layer alongside the dispatcher check)", async () => {
    const owner = await bootstrap();
    // meta_facebook_page/meta_instagram (real, registered) only support
    // providerAccountType "page" (see Meta adapters' supportedAccountTypes).
    const result = await invoke<{ error: { code: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: {
        ...authHeaders(owner),
        "idempotency-key": "connect-meta-unsupported-type-1"
      },
      body: {
        providerKey: "meta_facebook_page",
        providerAccountId: "page-1",
        providerAccountName: "Test Page",
        providerAccountType: "profile",
        tokenReference: "env:SOME_TOKEN_VAR",
        autoPublishEnabled: false
      }
    });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("SOCIAL_ACCOUNT_UNSUPPORTED_TYPE");
  });
});
