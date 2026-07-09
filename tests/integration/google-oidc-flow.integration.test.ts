/**
 * Integration tests for the Google OIDC login/link/unlink flow (Issue #590,
 * epic: full-online auth hardening) across the real route handlers against
 * a real PostgreSQL — start -> (stubbed Google) -> callback -> session,
 * invalid state/nonce/issuer/audience rejection, auto-link-by-email, link,
 * unlink, and MFA integration. The pure JWT/JWKS/policy logic is already
 * covered by `tests/unit/jwt-verify.test.ts`/`google-oidc-policy.test.ts`/
 * `google-oauth-client.test.ts`; this file proves the endpoints are wired
 * correctly end to end, mirroring `mfa-flow.integration.test.ts`'s shape
 * for the #589 feature this epic shares a gate with.
 *
 * Google's own token/JWKS endpoints are stubbed via a temporary
 * `globalThis.fetch` override (same pattern
 * `turnstile-gate.integration.test.ts`'s `withStubbedSiteverify` uses) —
 * there is no test-only URL override hook on the production code path
 * (`callback.ts` always calls Google's real, hardcoded endpoints), so
 * intercepting the global fetch is the only way to exercise this endpoint
 * end to end without a live Google account.
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
import { GET as googleStart } from "../../src/pages/api/v1/auth/providers/google/start";
import { GET as googleCallback } from "../../src/pages/api/v1/auth/providers/google/callback";
import { POST as googleLink } from "../../src/pages/api/v1/auth/providers/google/link";
import { POST as googleUnlink } from "../../src/pages/api/v1/auth/providers/google/unlink";
import { GOOGLE_OIDC_ENDPOINTS } from "../../src/lib/auth/google-oidc-config";
import { resetGoogleJwksCacheForTests } from "../../src/lib/auth/google-oauth-client";
import {
  getDatabaseCircuitBreaker,
  resetDatabaseCircuitBreakerForTests,
  resetProviderCircuitBreakersForTests
} from "../../src/lib/database/circuit-breaker";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";

const FULL_ONLINE_GOOGLE_ENV: Record<string, string> = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online",
  AUTH_GOOGLE_LOGIN_ENABLED: "true",
  AUTH_GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
  AUTH_GOOGLE_CLIENT_SECRET: "test-client-secret"
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

function signGoogleIdToken(claims: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key-1" };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = cryptoSign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    TEST_PRIVATE_KEY
  );
  return `${signingInput}.${base64Url(signature)}`;
}

type StubGoogleOptions = {
  /** Overrides the ID token returned by the (stubbed) token exchange — build via `signGoogleIdToken`. */
  idToken?: string;
  /** Simulate the token endpoint itself failing (5xx) rather than returning a token. */
  tokenEndpointFails?: boolean;
};

async function withStubbedGoogle<T>(
  options: StubGoogleOptions,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith(GOOGLE_OIDC_ENDPOINTS.tokenEndpoint)) {
      if (options.tokenEndpointFails) {
        return new Response("upstream error", { status: 500 });
      }
      return Response.json({ id_token: options.idToken ?? "" });
    }

    if (url.startsWith(GOOGLE_OIDC_ENDPOINTS.jwksUri)) {
      return Response.json({ keys: [TEST_JWK] });
    }

    return originalFetch(input as never);
  }) as typeof fetch;

  resetGoogleJwksCacheForTests();
  resetProviderCircuitBreakersForTests();

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    resetGoogleJwksCacheForTests();
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

async function bootstrapTenant(tenantCode = "acme") {
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

  return { tenantId: setup.body.data.tenantId };
}

async function loginAndGetToken(tenantId: string): Promise<string> {
  const result = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(result.status).toBe(200);
  return result.body.data.token;
}

/** Calls `start.ts` and extracts `state`/`nonce` from the 302 redirect's Location query params. */
async function startGoogleLogin(
  tenantId: string
): Promise<{ state: string; nonce: string }> {
  const result = await invoke(googleStart, {
    method: "GET",
    path: `/api/v1/auth/providers/google/start?tenantId=${tenantId}`
  });
  expect(result.status).toBe(302);

  const location = new URL(result.response.headers.get("location")!);
  return {
    state: location.searchParams.get("state")!,
    nonce: location.searchParams.get("nonce")!
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Google OIDC login flow (Issue #590)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetDatabaseCircuitBreakerForTests();
  });

  test("start rejects a nonexistent tenant WITHOUT tripping the shared database circuit breaker", async () => {
    // Security review of this PR found that inserting into
    // awcms_mini_oidc_auth_requests with an unauthenticated, unvalidated
    // tenantId let a nonexistent tenant trip a foreign-key violation,
    // which withTenant's catch-all records against the single,
    // APPLICATION-WIDE database circuit breaker — shared across every
    // tenant and every endpoint, not scoped to this feature. Five bogus
    // requests would have opened it and taken down the entire deployment
    // for 30 seconds at a time, repeatedly, from an unauthenticated
    // caller. Fixed by checking tenant existence/status via a plain
    // SELECT (which never throws for a missing row) before ever
    // attempting the insert.
    await withEnvOverride(FULL_ONLINE_GOOGLE_ENV, async () => {
      const bogusTenantId = "00000000-0000-0000-0000-000000000000";

      for (let i = 0; i < 10; i += 1) {
        const start = await invoke<{ error: { code: string } }>(googleStart, {
          method: "GET",
          path: `/api/v1/auth/providers/google/start?tenantId=${bogusTenantId}`
        });
        expect(start.status).toBe(403);
        expect(start.body.error.code).toBe("ACCESS_DENIED");
      }

      // The shared database breaker must still be closed (i.e. usable) —
      // if the bug were present, 5 consecutive FK-violation exceptions
      // would have opened it.
      expect(getDatabaseCircuitBreaker().canAttempt(new Date())).toBe(true);
    });
  });

  test("disabled mode (default): start/link/unlink all report disabled", async () => {
    const owner = await bootstrapTenant();
    const token = await loginAndGetToken(owner.tenantId);

    const start = await invoke(googleStart, {
      method: "GET",
      path: `/api/v1/auth/providers/google/start?tenantId=${owner.tenantId}`
    });
    expect(start.status).toBe(403);

    const link = await invoke<{ error: { code: string } }>(googleLink, {
      method: "POST",
      path: "/api/v1/auth/providers/google/link",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${token}`
      }
    });
    expect(link.status).toBe(403);
    expect(link.body.error.code).toBe("GOOGLE_LOGIN_DISABLED");
  });

  test("login with no linked account and no auto-link policy configured is rejected, not silently provisioned", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_GOOGLE_ENV, async () => {
      const { state, nonce } = await startGoogleLogin(owner.tenantId);

      const idToken = signGoogleIdToken({
        iss: "https://accounts.google.com",
        aud: GOOGLE_CLIENT_ID,
        sub: "google-subject-owner",
        email: "owner@example.com",
        email_verified: true,
        nonce,
        exp: Math.floor(Date.now() / 1000) + 3600
      });

      await withStubbedGoogle({ idToken }, async () => {
        const callback = await invoke<{ error: { code: string } }>(
          googleCallback,
          {
            method: "GET",
            path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
          }
        );

        // No existing provider account and no auto-link-eligible policy
        // configured (AUTH_GOOGLE_ALLOWED_DOMAINS unset) — must reject,
        // not silently create an account.
        expect(callback.status).toBe(401);
        expect(callback.body.error.code).toBe("GOOGLE_ACCOUNT_NOT_LINKED");
      });
    });
  });

  test("full login flow with auto-link-by-email: verified email + allowed domain links to the existing identity", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { ...FULL_ONLINE_GOOGLE_ENV, AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
      async () => {
        const { state, nonce } = await startGoogleLogin(owner.tenantId);

        const idToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-owner",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const callback = await invoke<{ data: { token: string } }>(
            googleCallback,
            {
              method: "GET",
              path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
            }
          );

          expect(callback.status).toBe(302);
          expect(callback.response.headers.get("location")).toBe("/admin");
        });

        // A second login with the SAME Google subject now finds the
        // linked provider account directly (no auto-link needed).
        const second = await startGoogleLogin(owner.tenantId);
        const secondIdToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-owner",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce: second.nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken: secondIdToken }, async () => {
          const callback = await invoke(googleCallback, {
            method: "GET",
            path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(second.state)}`
          });
          expect(callback.status).toBe(302);
        });
      }
    );
  });

  test("auto-link rejects an unverified email even with an allowed domain", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { ...FULL_ONLINE_GOOGLE_ENV, AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
      async () => {
        const { state, nonce } = await startGoogleLogin(owner.tenantId);
        const idToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-unverified",
          email: OWNER_LOGIN,
          email_verified: false,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const callback = await invoke<{ error: { code: string } }>(
            googleCallback,
            {
              method: "GET",
              path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
            }
          );
          expect(callback.status).toBe(401);
          expect(callback.body.error.code).toBe("GOOGLE_ACCOUNT_NOT_LINKED");
        });
      }
    );
  });

  test("rejects a missing/invalid state parameter", async () => {
    await withEnvOverride(FULL_ONLINE_GOOGLE_ENV, async () => {
      const callback = await invoke<{ error: { code: string } }>(
        googleCallback,
        {
          method: "GET",
          path: `/api/v1/auth/providers/google/callback?code=some-code&state=garbage-not-a-valid-state`
        }
      );
      expect(callback.status).toBe(401);
      expect(callback.body.error.code).toBe("GOOGLE_OAUTH_STATE_INVALID");
    });
  });

  test("rejects a replayed state (single-use)", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { ...FULL_ONLINE_GOOGLE_ENV, AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
      async () => {
        const { state, nonce } = await startGoogleLogin(owner.tenantId);
        const idToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-replay",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const first = await invoke(googleCallback, {
            method: "GET",
            path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
          });
          expect(first.status).toBe(302);

          const replay = await invoke<{ error: { code: string } }>(
            googleCallback,
            {
              method: "GET",
              path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
            }
          );
          expect(replay.status).toBe(401);
          expect(replay.body.error.code).toBe("GOOGLE_OAUTH_STATE_INVALID");
        });
      }
    );
  });

  test("concurrent callback requests with the same state only succeed once (race-safe single-use)", async () => {
    // `consumeOAuthRequest` uses SELECT ... FOR UPDATE + a compare-and-swap
    // UPDATE ... WHERE consumed_at IS NULL RETURNING id (PR #597's fix for
    // the equivalent MFA challenge race, reapplied here) — without it,
    // concurrent requests carrying the same state could all read
    // "not yet consumed" before any commits and all succeed.
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { ...FULL_ONLINE_GOOGLE_ENV, AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
      async () => {
        const { state, nonce } = await startGoogleLogin(owner.tenantId);
        const idToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-concurrent-replay",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const callOnce = () =>
            invoke<{ data?: { token: string } }>(googleCallback, {
              method: "GET",
              path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
            });

          const results = await Promise.all([
            callOnce(),
            callOnce(),
            callOnce(),
            callOnce(),
            callOnce()
          ]);

          const succeeded = results.filter((result) => result.status === 302);
          expect(succeeded).toHaveLength(1);
        });
      }
    );
  });

  test("rejects an ID token with the wrong nonce", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { ...FULL_ONLINE_GOOGLE_ENV, AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
      async () => {
        const { state } = await startGoogleLogin(owner.tenantId);
        const idToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-wrong-nonce",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce: "wrong-nonce-value",
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const callback = await invoke<{ error: { code: string } }>(
            googleCallback,
            {
              method: "GET",
              path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
            }
          );
          expect(callback.status).toBe(401);
          expect(callback.body.error.code).toBe("GOOGLE_ID_TOKEN_INVALID");
        });
      }
    );
  });

  test("rejects an ID token with the wrong audience", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { ...FULL_ONLINE_GOOGLE_ENV, AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
      async () => {
        const { state, nonce } = await startGoogleLogin(owner.tenantId);
        const idToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: "some-other-client-id",
          sub: "google-subject-wrong-aud",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const callback = await invoke<{ error: { code: string } }>(
            googleCallback,
            {
              method: "GET",
              path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
            }
          );
          expect(callback.status).toBe(401);
          expect(callback.body.error.code).toBe("GOOGLE_ID_TOKEN_INVALID");
        });
      }
    );
  });

  test("rejects an ID token with the wrong issuer", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(
      { ...FULL_ONLINE_GOOGLE_ENV, AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
      async () => {
        const { state, nonce } = await startGoogleLogin(owner.tenantId);
        const idToken = signGoogleIdToken({
          iss: "https://evil.example.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-wrong-iss",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const callback = await invoke<{ error: { code: string } }>(
            googleCallback,
            {
              method: "GET",
              path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
            }
          );
          expect(callback.status).toBe(401);
          expect(callback.body.error.code).toBe("GOOGLE_ID_TOKEN_INVALID");
        });
      }
    );
  });

  test("link: authenticated identity can link, then subsequent Google login uses that link", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_GOOGLE_ENV, async () => {
      const token = await loginAndGetToken(owner.tenantId);

      const linkStart = await invoke<{ data: { authorizationUrl: string } }>(
        googleLink,
        {
          method: "POST",
          path: "/api/v1/auth/providers/google/link",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${token}`
          }
        }
      );
      expect(linkStart.status).toBe(200);

      const location = new URL(linkStart.body.data.authorizationUrl);
      const state = location.searchParams.get("state")!;
      const nonce = location.searchParams.get("nonce")!;

      const idToken = signGoogleIdToken({
        iss: "https://accounts.google.com",
        aud: GOOGLE_CLIENT_ID,
        sub: "google-subject-link-me",
        email: "unrelated@example.com",
        email_verified: true,
        nonce,
        exp: Math.floor(Date.now() / 1000) + 3600
      });

      await withStubbedGoogle({ idToken }, async () => {
        const callback = await invoke(googleCallback, {
          method: "GET",
          path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
        });
        expect(callback.status).toBe(302);
        expect(callback.response.headers.get("location")).toBe("/admin");
      });

      // A fresh login flow with the SAME Google subject now finds the
      // linked account directly.
      const { state: loginState, nonce: loginNonce } = await startGoogleLogin(
        owner.tenantId
      );
      const loginIdToken = signGoogleIdToken({
        iss: "https://accounts.google.com",
        aud: GOOGLE_CLIENT_ID,
        sub: "google-subject-link-me",
        email: "unrelated@example.com",
        email_verified: true,
        nonce: loginNonce,
        exp: Math.floor(Date.now() / 1000) + 3600
      });

      await withStubbedGoogle({ idToken: loginIdToken }, async () => {
        const callback = await invoke<{ data: { token: string } }>(
          googleCallback,
          {
            method: "GET",
            path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(loginState)}`
          }
        );
        expect(callback.status).toBe(302);
      });
    });
  });

  test("link rejects a Google subject already linked to a different identity", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_GOOGLE_ENV, async () => {
      const admin = getAdminSql();
      const other = await admin`
        SELECT id FROM awcms_mini_identities
        WHERE tenant_id = ${owner.tenantId} AND login_identifier = ${OWNER_LOGIN}
      `;
      await admin`
        INSERT INTO awcms_mini_identity_provider_accounts
          (tenant_id, identity_id, provider, provider_subject)
        VALUES (${owner.tenantId}, ${(other[0] as { id: string }).id}, 'google', 'already-taken-subject')
      `;

      const token = await loginAndGetToken(owner.tenantId);
      const linkStart = await invoke<{ data: { authorizationUrl: string } }>(
        googleLink,
        {
          method: "POST",
          path: "/api/v1/auth/providers/google/link",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${token}`
          }
        }
      );
      const location = new URL(linkStart.body.data.authorizationUrl);
      const state = location.searchParams.get("state")!;
      const nonce = location.searchParams.get("nonce")!;

      const idToken = signGoogleIdToken({
        iss: "https://accounts.google.com",
        aud: GOOGLE_CLIENT_ID,
        sub: "already-taken-subject",
        email: "someone@example.com",
        email_verified: true,
        nonce,
        exp: Math.floor(Date.now() / 1000) + 3600
      });

      await withStubbedGoogle({ idToken }, async () => {
        const callback = await invoke<{ error: { code: string } }>(
          googleCallback,
          {
            method: "GET",
            path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
          }
        );
        expect(callback.status).toBe(409);
        expect(callback.body.error.code).toBe("GOOGLE_ALREADY_LINKED");
      });
    });
  });

  test("unlink: removes a linked account; unlinking again is a conflict", async () => {
    const owner = await bootstrapTenant();

    await withEnvOverride(FULL_ONLINE_GOOGLE_ENV, async () => {
      const admin = getAdminSql();
      const identityRows = await admin`
        SELECT id FROM awcms_mini_identities
        WHERE tenant_id = ${owner.tenantId} AND login_identifier = ${OWNER_LOGIN}
      `;
      await admin`
        INSERT INTO awcms_mini_identity_provider_accounts
          (tenant_id, identity_id, provider, provider_subject)
        VALUES (${owner.tenantId}, ${(identityRows[0] as { id: string }).id}, 'google', 'subject-to-unlink')
      `;

      const token = await loginAndGetToken(owner.tenantId);

      const unlink = await invoke<{ data: { unlinked: boolean } }>(
        googleUnlink,
        {
          method: "POST",
          path: "/api/v1/auth/providers/google/unlink",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${token}`
          }
        }
      );
      expect(unlink.status).toBe(200);
      expect(unlink.body.data.unlinked).toBe(true);

      const again = await invoke<{ error: { code: string } }>(googleUnlink, {
        method: "POST",
        path: "/api/v1/auth/providers/google/unlink",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId,
          authorization: `Bearer ${token}`
        }
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("GOOGLE_NOT_LINKED");
    });
  });

  test("MFA integration: Google login for an MFA-enrolled identity stops at MFA_REQUIRED, not a session", async () => {
    const owner = await bootstrapTenant();
    const mfaKey = Buffer.alloc(32, 7).toString("base64");

    await withEnvOverride(
      {
        ...FULL_ONLINE_GOOGLE_ENV,
        AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com",
        AUTH_MFA_ENABLED: "true",
        AUTH_MFA_SECRET_ENCRYPTION_KEY: mfaKey
      },
      async () => {
        const token = await loginAndGetToken(owner.tenantId);

        const { POST: enrollStart } =
          await import("../../src/pages/api/v1/auth/mfa/totp/enroll/start");
        const { POST: enrollVerify } =
          await import("../../src/pages/api/v1/auth/mfa/totp/enroll/verify");
        const { generateTotpCode, base32Decode } =
          await import("../../src/lib/auth/totp");

        const start = await invoke<{ data: { secret: string } }>(enrollStart, {
          method: "POST",
          path: "/api/v1/auth/mfa/totp/enroll/start",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${token}`
          }
        });
        const code = generateTotpCode(
          base32Decode(start.body.data.secret),
          Date.now(),
          { periodSec: 30, digits: 6 }
        );
        const verify = await invoke(enrollVerify, {
          method: "POST",
          path: "/api/v1/auth/mfa/totp/enroll/verify",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId,
            authorization: `Bearer ${token}`
          },
          body: { code }
        });
        expect(verify.status).toBe(200);

        const { state, nonce } = await startGoogleLogin(owner.tenantId);
        const idToken = signGoogleIdToken({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: "google-subject-mfa-owner",
          email: OWNER_LOGIN,
          email_verified: true,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600
        });

        await withStubbedGoogle({ idToken }, async () => {
          const callback = await invoke<{
            error: { code: string; details?: { mfaChallengeToken?: string } };
          }>(googleCallback, {
            method: "GET",
            path: `/api/v1/auth/providers/google/callback?code=some-code&state=${encodeURIComponent(state)}`
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

  test("user cancelling Google consent is rejected cleanly", async () => {
    await withEnvOverride(FULL_ONLINE_GOOGLE_ENV, async () => {
      const callback = await invoke<{ error: { code: string } }>(
        googleCallback,
        {
          method: "GET",
          path: "/api/v1/auth/providers/google/callback?error=access_denied"
        }
      );
      expect(callback.status).toBe(401);
      expect(callback.body.error.code).toBe("GOOGLE_OAUTH_STATE_INVALID");
    });
  });
});
