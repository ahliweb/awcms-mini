/**
 * Integration tests for the generic tenant OIDC SSO flow (Issue #591, epic:
 * full-online auth hardening) across the real route handlers against a
 * real PostgreSQL — gate behavior, admin CRUD + ABAC, break-glass
 * enforcement (both at policy-save time and at login time), start/callback/
 * link/unlink, auto-link-by-email, and the tenant-existence-check-before-
 * insert regression (PR #598's lesson, applied here from day one). Mirrors
 * `google-oidc-flow.integration.test.ts`'s shape for the #590 feature this
 * epic shares infrastructure with.
 *
 * The tenant-configured provider's discovery/token/JWKS endpoints are
 * stubbed via a temporary `globalThis.fetch` override (same pattern
 * `google-oidc-flow.integration.test.ts`'s `withStubbedGoogle` uses) —
 * there is no test-only URL override on `discoverOidcConfiguration`, so
 * intercepting the global fetch is the way to exercise this end to end.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

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
import { GET as ssoStart } from "../../src/pages/api/v1/auth/sso/[providerKey]/start";
import { GET as ssoCallback } from "../../src/pages/api/v1/auth/sso/[providerKey]/callback";
import { POST as ssoLink } from "../../src/pages/api/v1/auth/sso/[providerKey]/link";
import { POST as ssoUnlink } from "../../src/pages/api/v1/auth/sso/[providerKey]/unlink";
import {
  GET as listProviders,
  POST as createProvider
} from "../../src/pages/api/v1/identity/sso/providers/index";
import {
  GET as getPolicy,
  PATCH as updatePolicy
} from "../../src/pages/api/v1/identity/sso/policy/index";
import { resetGenericOidcCachesForTests } from "../../src/lib/auth/generic-oidc-client";
import {
  getDatabaseCircuitBreaker,
  resetDatabaseCircuitBreakerForTests,
  resetProviderCircuitBreakersForTests
} from "../../src/lib/database/circuit-breaker";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const OKTA_ISSUER = "https://acme.okta.example.com";
const OKTA_CLIENT_ID = "test-okta-client-id";

const FULL_ONLINE_SSO_ENV: Record<string, string> = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online",
  AUTH_SSO_ENABLED: "true"
};

function base64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input) : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_JWK = {
  ...(TEST_PUBLIC_KEY.export({ format: "jwk" }) as Record<string, unknown>),
  kid: "test-key-1"
};

function signIdToken(claims: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key-1" };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = cryptoSign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    TEST_PRIVATE_KEY
  );
  return `${signingInput}.${base64Url(signature)}`;
}

type StubOktaOptions = {
  idToken?: string;
  tokenEndpointFails?: boolean;
  discoveryFails?: boolean;
};

async function withStubbedOkta<T>(
  options: StubOktaOptions,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const tokenEndpoint = `${OKTA_ISSUER}/oauth2/v1/token`;
  const jwksUri = `${OKTA_ISSUER}/oauth2/v1/keys`;
  const authorizationEndpoint = `${OKTA_ISSUER}/oauth2/v1/authorize`;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === `${OKTA_ISSUER}/.well-known/openid-configuration`) {
      if (options.discoveryFails) {
        return new Response("upstream error", { status: 500 });
      }
      return Response.json({
        issuer: OKTA_ISSUER,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: tokenEndpoint,
        jwks_uri: jwksUri
      });
    }

    if (url === tokenEndpoint) {
      if (options.tokenEndpointFails) {
        return new Response("upstream error", { status: 500 });
      }
      return Response.json({ id_token: options.idToken ?? "" });
    }

    if (url === jwksUri) {
      return Response.json({ keys: [TEST_JWK] });
    }

    return originalFetch(input as never);
  }) as typeof fetch;

  resetGenericOidcCachesForTests();
  resetProviderCircuitBreakersForTests();

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    resetGenericOidcCachesForTests();
    resetProviderCircuitBreakersForTests();
  }
}

async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

type Bootstrap = { tenantId: string; token: string };

async function bootstrapTenant(tenantCode = "acme"): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: `Tenant ${tenantCode}`,
      tenantCode,
      officeCode: "hq",
      officeName: "Head Office",
      ownerLoginIdentifier: OWNER_LOGIN,
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
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function authHeaders(owner: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`
  };
}

/**
 * `POST /setup/initialize` is a once-per-database singleton lock — it
 * cannot be called twice to bootstrap two tenants in the same test (same
 * constraint `blog-content-admin-ui.integration.test.ts`'s
 * `provisionSecondTenantWithBlogPostAccess` docblock documents). A second
 * tenant with `identity_access.sso_providers.{create,read}` is provisioned
 * directly via `getAdminSql()` instead.
 */
async function provisionSecondTenantWithSsoProviderAccess(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-user@example.com`;
  const password = `integration-test-${tenantCode}-password`;
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${tenantId}, ${tenantCode}, ${`Tenant ${tenantCode}`})
  `;

  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'SSO Test User') RETURNING id
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
      VALUES (${tenantId}, 'sso_provider_manager', 'SSO Provider Manager') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'identity_access' AND activity_code = 'sso_providers'
        AND action IN ('create', 'read')
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

  return { tenantId, token: login.body.data.token };
}

async function createOktaProvider(
  owner: Bootstrap,
  overrides: Record<string, unknown> = {}
): Promise<{ id: string }> {
  const result = await invoke<{ data: { id: string } }>(createProvider, {
    method: "POST",
    path: "/api/v1/identity/sso/providers",
    headers: authHeaders(owner),
    body: {
      providerKey: "okta",
      displayName: "Okta",
      issuerUrl: OKTA_ISSUER,
      clientId: OKTA_CLIENT_ID,
      clientSecretEnvVar: "OKTA_TEST_CLIENT_SECRET",
      enabled: true,
      ...overrides
    }
  });
  expect(result.status).toBe(200);
  return { id: result.body.data.id };
}

/** Calls `start.ts` and extracts `state`/`nonce` from the 302 redirect's Location query params. */
async function startSsoLogin(
  tenantId: string
): Promise<{ state: string; nonce: string }> {
  const result = await invoke(ssoStart, {
    method: "GET",
    path: `/api/v1/auth/sso/okta/start?tenantId=${tenantId}`,
    params: { providerKey: "okta" }
  });
  expect(result.status).toBe(302);

  const location = new URL(result.response.headers.get("location")!);
  return {
    state: location.searchParams.get("state")!,
    nonce: location.searchParams.get("nonce")!
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Generic tenant OIDC SSO flow (Issue #591)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetDatabaseCircuitBreakerForTests();
    process.env.OKTA_TEST_CLIENT_SECRET = "okta-test-client-secret";
    process.env.AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(
      32,
      3
    ).toString("base64");
  });

  test("start rejects a nonexistent tenant WITHOUT tripping the shared database circuit breaker", async () => {
    await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
      const bogusTenantId = "00000000-0000-0000-0000-000000000000";

      for (let i = 0; i < 10; i += 1) {
        const start = await invoke<{ error: { code: string } }>(ssoStart, {
          method: "GET",
          path: `/api/v1/auth/sso/okta/start?tenantId=${bogusTenantId}`,
          params: { providerKey: "okta" }
        });
        expect(start.status).toBe(403);
        expect(start.body.error.code).toBe("ACCESS_DENIED");
      }

      expect(getDatabaseCircuitBreaker().canAttempt(new Date())).toBe(true);
    });
  });

  test("CRITICAL: two DIFFERENT tenants both naming their provider 'okta' get fully independent /start behavior (Issue #610 security-auditor finding)", async () => {
    // `provider_key` is only unique PER TENANT — two unrelated tenants
    // both naming their provider "okta" is normal and expected. An
    // earlier draft of this fix keyed generic-oidc-client.ts's discovery
    // cache/circuit-breaker by `providerKey` ALONE, so tenant A's
    // discovery result for a hostile/broken "okta" would be served
    // straight to tenant B's real, healthy "okta" — a cross-tenant
    // cache-poisoning bug, not just a rate-limit gap. This test drives
    // the real `/start` route for both tenants and proves tenant B's
    // login is completely unaffected by tenant A's failing provider.
    const tenantA = await bootstrapTenant("tenant-a");
    const tenantB =
      await provisionSecondTenantWithSsoProviderAccess("tenant-b");

    const attackerIssuer = "https://attacker.example.com";
    await createOktaProvider(tenantA, { issuerUrl: attackerIssuer });
    await createOktaProvider(tenantB);

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCallCount += 1;
      const url = typeof input === "string" ? input : input.toString();

      if (url.startsWith(attackerIssuer)) {
        return new Response("internal error", { status: 500 });
      }

      if (url === `${OKTA_ISSUER}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: OKTA_ISSUER,
          authorization_endpoint: `${OKTA_ISSUER}/oauth2/v1/authorize`,
          token_endpoint: `${OKTA_ISSUER}/oauth2/v1/token`,
          jwks_uri: `${OKTA_ISSUER}/oauth2/v1/keys`
        });
      }

      return originalFetch(input as never);
    }) as typeof fetch;
    resetGenericOidcCachesForTests();
    resetProviderCircuitBreakersForTests();

    try {
      await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
        const attackerTenantStart = await invoke<{ error: { code: string } }>(
          ssoStart,
          {
            method: "GET",
            path: `/api/v1/auth/sso/okta/start?tenantId=${tenantA.tenantId}`,
            params: { providerKey: "okta" }
          }
        );
        expect(attackerTenantStart.status).toBe(502);
        expect(attackerTenantStart.body.error.code).toBe(
          "SSO_PROVIDER_UNAVAILABLE"
        );

        // Tenant B's "okta" must succeed — completely unaffected by tenant
        // A's failing/hostile "okta" cache entry or circuit breaker.
        const victimTenantStart = await invoke(ssoStart, {
          method: "GET",
          path: `/api/v1/auth/sso/okta/start?tenantId=${tenantB.tenantId}`,
          params: { providerKey: "okta" }
        });
        expect(victimTenantStart.status).toBe(302);
        const location = new URL(
          victimTenantStart.response.headers.get("location")!
        );
        expect(location.origin).toBe(OKTA_ISSUER);

        expect(fetchCallCount).toBe(2);
      });
    } finally {
      globalThis.fetch = originalFetch;
      resetGenericOidcCachesForTests();
      resetProviderCircuitBreakersForTests();
    }
  });

  test("disabled mode (default): start/link/unlink all report SSO_DISABLED", async () => {
    const owner = await bootstrapTenant();

    const start = await invoke<{ error: { code: string } }>(ssoStart, {
      method: "GET",
      path: `/api/v1/auth/sso/okta/start?tenantId=${owner.tenantId}`,
      params: { providerKey: "okta" }
    });
    expect(start.status).toBe(403);
    expect(start.body.error.code).toBe("SSO_DISABLED");

    const link = await invoke<{ error: { code: string } }>(ssoLink, {
      method: "POST",
      path: "/api/v1/auth/sso/okta/link",
      headers: authHeaders(owner),
      params: { providerKey: "okta" }
    });
    expect(link.status).toBe(403);
    expect(link.body.error.code).toBe("SSO_DISABLED");

    const unlink = await invoke<{ error: { code: string } }>(ssoUnlink, {
      method: "POST",
      path: "/api/v1/auth/sso/okta/unlink",
      headers: authHeaders(owner),
      params: { providerKey: "okta" }
    });
    expect(unlink.status).toBe(403);
    expect(unlink.body.error.code).toBe("SSO_DISABLED");
  });

  test("admin CRUD is reachable even when the SSO gate is off — credentials can be provisioned ahead of time", async () => {
    const owner = await bootstrapTenant();

    const created = await createOktaProvider(owner);
    expect(created.id).toBeTruthy();

    const list = await invoke<{
      data: { providers: { providerKey: string }[] };
    }>(listProviders, {
      method: "GET",
      path: "/api/v1/identity/sso/providers",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.providers).toHaveLength(1);
    expect(list.body.data.providers[0]?.providerKey).toBe("okta");
  });

  test("create is rejected once the tenant reaches AUTH_SSO_MAX_PROVIDERS_PER_TENANT (Issue #612)", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { AUTH_SSO_MAX_PROVIDERS_PER_TENANT: "2" },
      async () => {
        const first = await invoke<{ data: { id: string } }>(createProvider, {
          method: "POST",
          path: "/api/v1/identity/sso/providers",
          headers: authHeaders(owner),
          body: {
            providerKey: "okta",
            displayName: "Okta",
            issuerUrl: OKTA_ISSUER,
            clientId: OKTA_CLIENT_ID,
            clientSecretEnvVar: "OKTA_TEST_CLIENT_SECRET",
            enabled: true
          }
        });
        expect(first.status).toBe(200);

        const second = await invoke<{ data: { id: string } }>(createProvider, {
          method: "POST",
          path: "/api/v1/identity/sso/providers",
          headers: authHeaders(owner),
          body: {
            providerKey: "azure-ad",
            displayName: "Azure AD",
            issuerUrl: "https://login.microsoftonline.com/tenant/v2.0",
            clientId: "azure-client-id",
            clientSecretEnvVar: "AZURE_TEST_CLIENT_SECRET",
            enabled: true
          }
        });
        expect(second.status).toBe(200);

        const third = await invoke<{ error: { code: string } }>(
          createProvider,
          {
            method: "POST",
            path: "/api/v1/identity/sso/providers",
            headers: authHeaders(owner),
            body: {
              providerKey: "keycloak",
              displayName: "Keycloak",
              issuerUrl: "https://idp.example.com/realms/tenant",
              clientId: "keycloak-client-id",
              clientSecretEnvVar: "KEYCLOAK_TEST_CLIENT_SECRET",
              enabled: true
            }
          }
        );
        expect(third.status).toBe(409);
        expect(third.body.error.code).toBe("SSO_PROVIDER_LIMIT_EXCEEDED");

        const list = await invoke<{ data: { providers: unknown[] } }>(
          listProviders,
          {
            method: "GET",
            path: "/api/v1/identity/sso/providers",
            headers: authHeaders(owner)
          }
        );
        expect(list.body.data.providers).toHaveLength(2);
      }
    );
  });

  test("admin CRUD never returns the client secret plaintext", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner, {
      clientSecretEnvVar: undefined,
      clientSecret: "super-secret-value"
    });

    const list = await invoke<{
      data: { providers: Record<string, unknown>[] };
    }>(listProviders, {
      method: "GET",
      path: "/api/v1/identity/sso/providers",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);

    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain("super-secret-value");
    expect(list.body.data.providers[0]).not.toHaveProperty("clientSecret");
    expect(list.body.data.providers[0]).not.toHaveProperty(
      "clientSecretCiphertext"
    );
  });

  test("ABAC: an identity with no role/permission is denied admin provider access (default deny)", async () => {
    const owner = await bootstrapTenant();
    const admin = getAdminSql();

    const profileRows = await admin`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${owner.tenantId}, 'person', 'No Role User') RETURNING id
    `;
    const password = "integration-test-norole-password";
    const passwordHash = await Bun.password.hash(password);
    await admin`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${owner.tenantId}, ${(profileRows[0] as { id: string }).id}, 'norole@example.com', ${passwordHash})
    `;
    const identityRows = await admin`
      SELECT id FROM awcms_mini_identities WHERE login_identifier = 'norole@example.com'
    `;
    await admin`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${owner.tenantId}, ${(identityRows[0] as { id: string }).id})
    `;

    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId
      },
      body: { loginIdentifier: "norole@example.com", password },
      cookies: createCookieJar()
    });
    expect(login.status).toBe(200);

    const list = await invoke<{ error: { code: string } }>(listProviders, {
      method: "GET",
      path: "/api/v1/identity/sso/providers",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${login.body.data.token}`
      }
    });
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe("ACCESS_DENIED");
  });

  test("full login flow with auto-link-by-email: verified email + allowed domain (provider AND policy) links to the existing identity", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner, { allowedEmailDomains: ["example.com"] });

    const patchPolicy = await invoke(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { autoLinkVerifiedEmail: true }
    });
    expect(patchPolicy.status).toBe(200);

    await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
      const options: StubOktaOptions = {};

      await withStubbedOkta(options, async () => {
        const { state, nonce } = await startSsoLogin(owner.tenantId);
        options.idToken = signIdToken({
          iss: OKTA_ISSUER,
          aud: OKTA_CLIENT_ID,
          sub: "okta-subject-owner",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        const callback = await invoke<{ data: { token: string } }>(
          ssoCallback,
          {
            method: "GET",
            path: `/api/v1/auth/sso/okta/callback?code=some-code&state=${encodeURIComponent(state)}`,
            params: { providerKey: "okta" }
          }
        );
        expect(callback.status).toBe(302);
        expect(callback.response.headers.get("location")).toBe("/admin");
      });
    });
  });

  test("login with no linked account and auto-link disabled is rejected, not silently provisioned", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner, { allowedEmailDomains: ["example.com"] });
    // auto_link_verified_email left at its default (false).

    await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
      const options: StubOktaOptions = {};

      await withStubbedOkta(options, async () => {
        const { state, nonce } = await startSsoLogin(owner.tenantId);
        options.idToken = signIdToken({
          iss: OKTA_ISSUER,
          aud: OKTA_CLIENT_ID,
          sub: "okta-subject-owner",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        const callback = await invoke<{ error: { code: string } }>(
          ssoCallback,
          {
            method: "GET",
            path: `/api/v1/auth/sso/okta/callback?code=some-code&state=${encodeURIComponent(state)}`,
            params: { providerKey: "okta" }
          }
        );
        expect(callback.status).toBe(401);
        expect(callback.body.error.code).toBe("SSO_ACCOUNT_NOT_LINKED");
      });
    });
  });

  test("link then subsequent login uses the linked account; unlink then removes it", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner);

    await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
      const options: StubOktaOptions = {};

      await withStubbedOkta(options, async () => {
        const linkStart = await invoke<{ data: { authorizationUrl: string } }>(
          ssoLink,
          {
            method: "POST",
            path: "/api/v1/auth/sso/okta/link",
            headers: authHeaders(owner),
            params: { providerKey: "okta" }
          }
        );
        expect(linkStart.status).toBe(200);

        const location = new URL(linkStart.body.data.authorizationUrl);
        const state = location.searchParams.get("state")!;
        const nonce = location.searchParams.get("nonce")!;

        options.idToken = signIdToken({
          iss: OKTA_ISSUER,
          aud: OKTA_CLIENT_ID,
          sub: "okta-subject-link-me",
          email: "unrelated@example.com",
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        const callback = await invoke(ssoCallback, {
          method: "GET",
          path: `/api/v1/auth/sso/okta/callback?code=some-code&state=${encodeURIComponent(state)}`,
          params: { providerKey: "okta" }
        });
        expect(callback.status).toBe(302);
      });

      const unlink = await invoke<{ data: { unlinked: boolean } }>(ssoUnlink, {
        method: "POST",
        path: "/api/v1/auth/sso/okta/unlink",
        headers: authHeaders(owner),
        params: { providerKey: "okta" }
      });
      expect(unlink.status).toBe(200);
      expect(unlink.body.data.unlinked).toBe(true);

      const again = await invoke<{ error: { code: string } }>(ssoUnlink, {
        method: "POST",
        path: "/api/v1/auth/sso/okta/unlink",
        headers: authHeaders(owner),
        params: { providerKey: "okta" }
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("SSO_NOT_LINKED");
    });
  });

  test("break-glass enforcement: PATCH policy rejects sso_required=true with no eligible break-glass identity, accepts once one is provided", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner);

    const rejected = await invoke<{ error: { code: string } }>(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { ssoEnabled: true, ssoRequired: true }
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("BREAK_GLASS_REQUIRED");

    // Confirm the rejected policy was NOT persisted.
    const unchanged = await invoke<{ data: { ssoRequired: boolean } }>(
      getPolicy,
      {
        method: "GET",
        path: "/api/v1/identity/sso/policy",
        headers: authHeaders(owner)
      }
    );
    expect(unchanged.body.data.ssoRequired).toBe(false);

    const admin = getAdminSql();
    const ownerIdentityRows = await admin`
      SELECT id FROM awcms_mini_identities
      WHERE tenant_id = ${owner.tenantId} AND login_identifier = ${OWNER_LOGIN}
    `;
    const ownerIdentityId = (ownerIdentityRows[0] as { id: string }).id;

    const accepted = await invoke<{ data: { ssoRequired: boolean } }>(
      updatePolicy,
      {
        method: "PATCH",
        path: "/api/v1/identity/sso/policy",
        headers: authHeaders(owner),
        body: {
          ssoEnabled: true,
          ssoRequired: true,
          breakGlassIdentityIds: [ownerIdentityId]
        }
      }
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.ssoRequired).toBe(true);
  });

  test("break-glass hygiene: saving policy with 1 valid + N garbage/ineligible ids persists ONLY the valid one (Issue #605)", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner);

    const admin = getAdminSql();
    const ownerIdentityRows = await admin`
      SELECT id FROM awcms_mini_identities
      WHERE tenant_id = ${owner.tenantId} AND login_identifier = ${OWNER_LOGIN}
    `;
    const ownerIdentityId = (ownerIdentityRows[0] as { id: string }).id;

    // Two syntactically valid UUIDs that don't correspond to any identity in
    // this (or any) tenant — `validateUpdateTenantAuthPolicyInput` only
    // checks UUID *shape*, so these pass input validation and reach
    // `saveTenantAuthPolicy`, exactly like a soft-deleted/typo'd real id
    // would. Neither should ever end up persisted in
    // `break_glass_identity_ids`, only the one id the server itself
    // confirmed eligible via a fresh DB read.
    const nonexistentId1 = "00000000-0000-0000-0000-000000000000";
    const nonexistentId2 = "11111111-2222-3333-4444-555555555555";

    const accepted = await invoke<{
      data: { ssoRequired: boolean; breakGlassIdentityIds: string[] };
    }>(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: {
        ssoEnabled: true,
        ssoRequired: true,
        breakGlassIdentityIds: [ownerIdentityId, nonexistentId1, nonexistentId2]
      }
    });

    expect(accepted.status).toBe(200);
    expect(accepted.body.data.ssoRequired).toBe(true);
    expect(accepted.body.data.breakGlassIdentityIds).toEqual([ownerIdentityId]);

    // Confirm the garbage/nonexistent ids were never persisted, not just
    // absent from this response — read the policy back fresh.
    const reread = await invoke<{
      data: { breakGlassIdentityIds: string[] };
    }>(getPolicy, {
      method: "GET",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner)
    });
    expect(reread.body.data.breakGlassIdentityIds).toEqual([ownerIdentityId]);
  });

  test("break-glass enforcement also rejects password_login_enabled=false without an eligible break-glass identity", async () => {
    const owner = await bootstrapTenant();

    const rejected = await invoke<{ error: { code: string } }>(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { ssoEnabled: true, passwordLoginEnabled: false }
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("BREAK_GLASS_REQUIRED");
  });

  test("login enforcement: password_login_enabled=false blocks a non-break-glass identity but not the break-glass owner, only when the SSO gate is active", async () => {
    const owner = await bootstrapTenant();
    const admin = getAdminSql();

    const ownerIdentityRows = await admin`
      SELECT id FROM awcms_mini_identities
      WHERE tenant_id = ${owner.tenantId} AND login_identifier = ${OWNER_LOGIN}
    `;
    const ownerIdentityId = (ownerIdentityRows[0] as { id: string }).id;

    const otherPassword = "integration-test-other-password";
    const otherPasswordHash = await Bun.password.hash(otherPassword);
    const profileRows = await admin`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${owner.tenantId}, 'person', 'Other User') RETURNING id
    `;
    await admin`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${owner.tenantId}, ${(profileRows[0] as { id: string }).id}, 'other@example.com', ${otherPasswordHash})
    `;
    const otherIdentityRows = await admin`
      SELECT id FROM awcms_mini_identities WHERE login_identifier = 'other@example.com'
    `;
    await admin`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${owner.tenantId}, ${(otherIdentityRows[0] as { id: string }).id})
    `;

    const patch = await invoke<{ data: { passwordLoginEnabled: boolean } }>(
      updatePolicy,
      {
        method: "PATCH",
        path: "/api/v1/identity/sso/policy",
        headers: authHeaders(owner),
        body: {
          ssoEnabled: true,
          passwordLoginEnabled: false,
          breakGlassIdentityIds: [ownerIdentityId]
        }
      }
    );
    expect(patch.status).toBe(200);
    expect(patch.body.data.passwordLoginEnabled).toBe(false);

    // Gate INACTIVE (default env): policy is stored but not enforced yet —
    // both identities can still log in with their password, exactly like
    // before this issue, on every deployment that never flips the #591 gate.
    const otherLoginGateOff = await invoke<{ data: { token: string } }>(
      authLogin,
      {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: "other@example.com", password: otherPassword },
        cookies: createCookieJar()
      }
    );
    expect(otherLoginGateOff.status).toBe(200);

    await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
      // Gate ACTIVE: the non-break-glass identity is now blocked...
      const otherLogin = await invoke<{ error: { code: string } }>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: {
          loginIdentifier: "other@example.com",
          password: otherPassword
        },
        cookies: createCookieJar()
      });
      expect(otherLogin.status).toBe(403);
      expect(otherLogin.body.error.code).toBe("PASSWORD_LOGIN_DISABLED");

      // ...but the break-glass owner identity can still log in with password.
      const ownerLogin = await invoke<{ data: { token: string } }>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
        cookies: createCookieJar()
      });
      expect(ownerLogin.status).toBe(200);
    });
  });

  test("rejects an ID token with the wrong issuer", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner, { allowedEmailDomains: ["example.com"] });
    await invoke(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { autoLinkVerifiedEmail: true }
    });

    await withEnvOverride(FULL_ONLINE_SSO_ENV, async () => {
      const options: StubOktaOptions = {};

      await withStubbedOkta(options, async () => {
        const { state, nonce } = await startSsoLogin(owner.tenantId);
        options.idToken = signIdToken({
          iss: "https://evil.example.com",
          aud: OKTA_CLIENT_ID,
          sub: "okta-subject-wrong-iss",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        const callback = await invoke<{ error: { code: string } }>(
          ssoCallback,
          {
            method: "GET",
            path: `/api/v1/auth/sso/okta/callback?code=some-code&state=${encodeURIComponent(state)}`,
            params: { providerKey: "okta" }
          }
        );
        expect(callback.status).toBe(401);
        expect(callback.body.error.code).toBe("SSO_ID_TOKEN_INVALID");
      });
    });
  });

  test("MFA integration: SSO login for an MFA-enrolled identity stops at MFA_REQUIRED, not a session", async () => {
    const owner = await bootstrapTenant();
    await createOktaProvider(owner, { allowedEmailDomains: ["example.com"] });
    await invoke(updatePolicy, {
      method: "PATCH",
      path: "/api/v1/identity/sso/policy",
      headers: authHeaders(owner),
      body: { autoLinkVerifiedEmail: true }
    });
    const mfaKey = Buffer.alloc(32, 7).toString("base64");

    await withEnvOverride(
      {
        ...FULL_ONLINE_SSO_ENV,
        AUTH_MFA_ENABLED: "true",
        AUTH_MFA_SECRET_ENCRYPTION_KEY: mfaKey
      },
      async () => {
        const { POST: enrollStart } =
          await import("../../src/pages/api/v1/auth/mfa/totp/enroll/start");
        const { POST: enrollVerify } =
          await import("../../src/pages/api/v1/auth/mfa/totp/enroll/verify");
        const { generateTotpCode, base32Decode } =
          await import("../../src/lib/auth/totp");

        const start = await invoke<{ data: { secret: string } }>(enrollStart, {
          method: "POST",
          path: "/api/v1/auth/mfa/totp/enroll/start",
          headers: authHeaders(owner)
        });
        const code = generateTotpCode(
          base32Decode(start.body.data.secret),
          Date.now(),
          { periodSec: 30, digits: 6 }
        );
        const verify = await invoke(enrollVerify, {
          method: "POST",
          path: "/api/v1/auth/mfa/totp/enroll/verify",
          headers: authHeaders(owner),
          body: { code }
        });
        expect(verify.status).toBe(200);

        const options: StubOktaOptions = {};

        await withStubbedOkta(options, async () => {
          const { state, nonce } = await startSsoLogin(owner.tenantId);
          options.idToken = signIdToken({
            iss: OKTA_ISSUER,
            aud: OKTA_CLIENT_ID,
            sub: "okta-subject-mfa-owner",
            email: OWNER_LOGIN,
            email_verified: true,
            nonce,
            exp: Math.floor(Date.now() / 1000) + 3600
          });

          const callback = await invoke<{
            error: { code: string; details?: { mfaChallengeToken?: string } };
          }>(ssoCallback, {
            method: "GET",
            path: `/api/v1/auth/sso/okta/callback?code=some-code&state=${encodeURIComponent(state)}`,
            params: { providerKey: "okta" }
          });

          expect(callback.status).toBe(401);
          expect(callback.body.error.code).toBe("MFA_REQUIRED");
          expect(typeof callback.body.error.details?.mfaChallengeToken).toBe(
            "string"
          );
        });
      }
    );
  });
});
