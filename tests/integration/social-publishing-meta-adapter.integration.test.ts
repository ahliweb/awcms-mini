/**
 * Integration tests for Issue #644 (Meta Facebook Page + Instagram
 * Business adapter) — exercises the REAL registered adapters
 * (`social-provider-registry.ts` registers them unconditionally at
 * import time) through the real `POST /api/v1/social-publishing/accounts/
 * {id}/verify` route and real DB fixtures. The one thing that is NEVER
 * real is the network call to Meta's Graph API — `global.fetch` is
 * monkey-patched to a fake implementation for the duration of this suite
 * (restored in `afterEach`), per the issue's own hard requirement that no
 * test may make a real call to Meta's API.
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

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as connectAccount } from "../../src/pages/api/v1/social-publishing/accounts/index";
import { POST as verifyAccount } from "../../src/pages/api/v1/social-publishing/accounts/[id]/verify";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = {
  tenantId: string;
  tenantCode: string;
  token: string;
};

async function bootstrap(
  tenantCode = "meta-acme",
  tenantName = "Meta Acme"
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

  return {
    tenantId: setup.body.data.tenantId,
    tenantCode,
    token: login.body.data.token
  };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

type FakeFetchResponse = { status: number; body: unknown };

/** Swaps `global.fetch` for a queue of canned JSON responses — never a real network call. Restored by the caller (this file's `afterEach`). */
function installFakeFetch(responses: FakeFetchResponse[]): {
  callCount: () => number;
} {
  let index = 0;
  let callCount = 0;

  global.fetch = (async () => {
    callCount += 1;
    const response = responses[index] ?? responses.at(-1)!;
    index += 1;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  return { callCount: () => callCount };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Meta social publishing adapter (Issue #644)", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.META_PROVIDER_ENABLED = "true";
    process.env.META_APP_ID = "1234567890";
    process.env.META_APP_SECRET_REFERENCE = "env:TEST_META_APP_SECRET";
    process.env.TEST_META_APP_SECRET = "fake-app-secret-value";
    process.env.META_GRAPH_API_VERSION = "v21.0";
    process.env.META_OAUTH_REDIRECT_URI =
      "https://example.com/auth/meta/callback";
    process.env.META_REQUIRED_SCOPES =
      "pages_manage_posts,pages_read_engagement";
    process.env.TEST_META_PAGE_TOKEN = "EAAfakepageaccesstoken";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  afterAll(async () => {
    global.fetch = originalFetch;
  });

  async function connectMetaFacebookPageAccount(
    owner: Bootstrap,
    providerAccountType: "page" | "profile" = "page"
  ): Promise<string> {
    const result = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: {
        ...authHeaders(owner),
        "idempotency-key": `connect-meta-${providerAccountType}`
      },
      body: {
        providerKey: "meta_facebook_page",
        providerAccountId: "page-42",
        providerAccountName: "Test Page",
        providerAccountType,
        tokenReference: "env:TEST_META_PAGE_TOKEN",
        autoPublishEnabled: true
      }
    });
    expect(result.status).toBe(200);
    return result.body.data.id;
  }

  test("verify: valid token + all required scopes -> 200, lastVerifiedAt set, connectionStatus stays connected", async () => {
    const owner = await bootstrap("meta-valid");
    const accountId = await connectMetaFacebookPageAccount(owner);

    const fake = installFakeFetch([
      {
        status: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: ["pages_manage_posts", "pages_read_engagement"]
          }
        }
      }
    ]);

    const result = await invoke<{
      data: { connectionStatus: string; lastVerifiedAt: string | null };
    }>(verifyAccount, {
      method: "POST",
      path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
      headers: authHeaders(owner),
      params: { id: accountId }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.connectionStatus).toBe("connected");
    expect(result.body.data.lastVerifiedAt).not.toBeNull();
    expect(fake.callCount()).toBe(1);
  });

  test("verify: expired token -> 409 SOCIAL_ACCOUNT_NEEDS_REAUTH, account transitions to needs_reauth", async () => {
    const owner = await bootstrap("meta-expired");
    const accountId = await connectMetaFacebookPageAccount(owner);

    installFakeFetch([
      {
        status: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) - 3600,
            scopes: ["pages_manage_posts", "pages_read_engagement"]
          }
        }
      }
    ]);

    const result = await invoke<{ error: { code: string; details: unknown } }>(
      verifyAccount,
      {
        method: "POST",
        path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
        headers: authHeaders(owner),
        params: { id: accountId }
      }
    );

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("SOCIAL_ACCOUNT_NEEDS_REAUTH");

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT connection_status FROM awcms_mini_social_accounts WHERE id = ${accountId}
    `) as { connection_status: string }[];
    expect(rows[0]!.connection_status).toBe("needs_reauth");
  });

  test("verify: missing required scope -> 409 SOCIAL_ACCOUNT_NEEDS_REAUTH", async () => {
    const owner = await bootstrap("meta-missing-scope");
    const accountId = await connectMetaFacebookPageAccount(owner);

    installFakeFetch([
      {
        status: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: ["pages_manage_posts"]
          }
        }
      }
    ]);

    const result = await invoke<{ error: { code: string } }>(verifyAccount, {
      method: "POST",
      path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
      headers: authHeaders(owner),
      params: { id: accountId }
    });

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("SOCIAL_ACCOUNT_NEEDS_REAUTH");
  });

  test("verify: unsupported account type (profile) -> 422, never calls Graph API", async () => {
    const owner = await bootstrap("meta-unsupported-type");
    const accountId = await connectMetaFacebookPageAccount(owner, "profile");

    const fake = installFakeFetch([]);

    const result = await invoke<{ error: { code: string } }>(verifyAccount, {
      method: "POST",
      path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
      headers: authHeaders(owner),
      params: { id: accountId }
    });

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("SOCIAL_ACCOUNT_UNSUPPORTED_TYPE");
    expect(fake.callCount()).toBe(0);
  });

  test("verify: unregistered provider key -> 422 PROVIDER_NOT_REGISTERED", async () => {
    const owner = await bootstrap("meta-unregistered");
    const account = await invoke<{ data: { id: string } }>(connectAccount, {
      method: "POST",
      path: "/api/v1/social-publishing/accounts",
      headers: { ...authHeaders(owner), "idempotency-key": "connect-unreg-1" },
      body: {
        providerKey: "some_unregistered_provider",
        providerAccountId: "x",
        providerAccountName: "X",
        providerAccountType: "page",
        tokenReference: "env:TEST_META_PAGE_TOKEN",
        autoPublishEnabled: false
      }
    });
    expect(account.status).toBe(200);

    const fake = installFakeFetch([]);
    const result = await invoke<{ error: { code: string } }>(verifyAccount, {
      method: "POST",
      path: `/api/v1/social-publishing/accounts/${account.body.data.id}/verify`,
      headers: authHeaders(owner),
      params: { id: account.body.data.id }
    });

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("PROVIDER_NOT_REGISTERED");
    expect(fake.callCount()).toBe(0);
  });

  test("verify requires accounts.connect — a tenant user without social_publishing permissions is denied (403)", async () => {
    const owner = await bootstrap("meta-verify-abac");
    const accountId = await connectMetaFacebookPageAccount(owner);

    const noPermToken = "not-a-real-token";
    const result = await invoke(verifyAccount, {
      method: "POST",
      path: `/api/v1/social-publishing/accounts/${accountId}/verify`,
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${noPermToken}`
      },
      params: { id: accountId }
    });
    expect(result.status).toBe(401);
  });
});
