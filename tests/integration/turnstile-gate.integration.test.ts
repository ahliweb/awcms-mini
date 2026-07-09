/**
 * Integration tests for the Cloudflare Turnstile gate (Issue #588, epic:
 * full-online auth hardening) across the four endpoints it applies to:
 * `POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`, and
 * `/setup/initialize`. Exercises the real handlers against a real
 * PostgreSQL — the pure verify-logic itself (timeout, redaction, circuit
 * breaker) is already covered by `tests/unit/turnstile.test.ts`; this file
 * proves the four endpoints actually call `enforceTurnstileIfRequired`
 * before their expensive DB/password work, not just that the function
 * itself is correct in isolation.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as passwordForgot } from "../../src/pages/api/v1/auth/password/forgot";
import { POST as passwordReset } from "../../src/pages/api/v1/auth/password/reset";
import { resetRateLimitStoreForTests } from "../../src/lib/security/rate-limit";
import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

const FULL_ONLINE_TURNSTILE_ENV: Record<string, string> = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online",
  TURNSTILE_ENABLED: "true",
  TURNSTILE_SITE_KEY: "site-key-test",
  TURNSTILE_SECRET_KEY: "secret-key-test"
};

/**
 * Temporarily overrides `process.env` keys for the duration of `fn`, then
 * restores the previous values (or deletes the key if it was previously
 * unset). Same pattern `blog-content-public-news.integration.test.ts` uses
 * for the same reason: route handlers read the real `process.env`, so this
 * is the only way to exercise a non-default gate state through the real
 * handler.
 */
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

/** Stubs global `fetch` for the duration of `fn` — stands in for Cloudflare's siteverify endpoint, which `resolveTurnstileConfig` gives no way to redirect via env. */
async function withStubbedSiteverify<T>(
  success: boolean,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ success })) as unknown as typeof fetch;

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
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

const suite = integrationEnabled ? describe : describe.skip;

suite("Turnstile gate across auth endpoints (Issue #588)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetRateLimitStoreForTests();
    resetProviderCircuitBreakersForTests();
  });

  test("login: disabled mode (default) requires no turnstileToken, unaffected", async () => {
    const owner = await bootstrapTenant();

    const result = await invoke(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId
      },
      body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
      cookies: createCookieJar()
    });

    expect(result.status).toBe(200);
  });

  test("login: enabled mode rejects a request with no turnstileToken (400 TURNSTILE_REQUIRED), before any password verification", async () => {
    const owner = await bootstrapTenant();

    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      invoke<{ error: { code: string } }>(authLogin, {
        method: "POST",
        path: "/api/v1/auth/login",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        // Deliberately wrong password — if Turnstile were checked AFTER
        // password verification, this would surface AUTH_INVALID_CREDENTIALS
        // instead, proving the ordering is wrong.
        body: { loginIdentifier: OWNER_LOGIN, password: "wrong-password" },
        cookies: createCookieJar()
      })
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("TURNSTILE_REQUIRED");
  });

  test("login: enabled mode rejects an invalid turnstileToken (400 TURNSTILE_INVALID)", async () => {
    const owner = await bootstrapTenant();

    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      withStubbedSiteverify(false, () =>
        invoke<{ error: { code: string } }>(authLogin, {
          method: "POST",
          path: "/api/v1/auth/login",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId
          },
          body: {
            loginIdentifier: OWNER_LOGIN,
            password: OWNER_PASSWORD,
            turnstileToken: "bad-token"
          },
          cookies: createCookieJar()
        })
      )
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("TURNSTILE_INVALID");
  });

  test("login: enabled mode accepts a valid turnstileToken end to end", async () => {
    const owner = await bootstrapTenant();

    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      withStubbedSiteverify(true, () =>
        invoke<{ data: { token: string } }>(authLogin, {
          method: "POST",
          path: "/api/v1/auth/login",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId
          },
          body: {
            loginIdentifier: OWNER_LOGIN,
            password: OWNER_PASSWORD,
            turnstileToken: "good-token"
          },
          cookies: createCookieJar()
        })
      )
    );

    expect(result.status).toBe(200);
    expect(typeof result.body.data.token).toBe("string");
  });

  test("password/forgot: enabled mode rejects a request with no turnstileToken, before any DB write", async () => {
    const owner = await bootstrapTenant();

    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      invoke<{ error: { code: string } }>(passwordForgot, {
        method: "POST",
        path: "/api/v1/auth/password/forgot",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { loginIdentifier: OWNER_LOGIN }
      })
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("TURNSTILE_REQUIRED");
  });

  test("password/forgot: enabled mode accepts a valid turnstileToken end to end", async () => {
    const owner = await bootstrapTenant();

    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      withStubbedSiteverify(true, () =>
        invoke<{ data: { requested: boolean } }>(passwordForgot, {
          method: "POST",
          path: "/api/v1/auth/password/forgot",
          headers: {
            "content-type": "application/json",
            "x-awcms-mini-tenant-id": owner.tenantId
          },
          body: {
            loginIdentifier: OWNER_LOGIN,
            turnstileToken: "good-token"
          }
        })
      )
    );

    expect(result.status).toBe(200);
    expect(result.body.data.requested).toBe(true);
  });

  test("password/reset: enabled mode rejects a request with no turnstileToken, before any token lookup", async () => {
    const owner = await bootstrapTenant();

    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      invoke<{ error: { code: string } }>(passwordReset, {
        method: "POST",
        path: "/api/v1/auth/password/reset",
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        body: { token: "irrelevant-token", newPassword: "New-Password-123" }
      })
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("TURNSTILE_REQUIRED");
  });

  test("setup/initialize: enabled mode rejects a request with no turnstileToken, before creating the tenant", async () => {
    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      invoke<{ error: { code: string } }>(setupInitialize, {
        method: "POST",
        path: "/api/v1/setup/initialize",
        headers: { "content-type": "application/json" },
        body: {
          tenantName: "Tenant no-token",
          tenantCode: "no-token",
          officeCode: "hq",
          officeName: "Head Office",
          ownerLoginIdentifier: OWNER_LOGIN,
          ownerPassword: OWNER_PASSWORD,
          ownerDisplayName: "Owner"
        }
      })
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("TURNSTILE_REQUIRED");
  });

  test("setup/initialize: enabled mode accepts a valid turnstileToken end to end", async () => {
    const result = await withEnvOverride(FULL_ONLINE_TURNSTILE_ENV, () =>
      withStubbedSiteverify(true, () =>
        invoke<{ data: { tenantId: string } }>(setupInitialize, {
          method: "POST",
          path: "/api/v1/setup/initialize",
          headers: { "content-type": "application/json" },
          body: {
            tenantName: "Tenant with token",
            tenantCode: "with-token",
            officeCode: "hq",
            officeName: "Head Office",
            ownerLoginIdentifier: OWNER_LOGIN,
            ownerPassword: OWNER_PASSWORD,
            ownerDisplayName: "Owner",
            turnstileToken: "good-token"
          }
        })
      )
    );

    expect(result.status).toBe(200);
    expect(typeof result.body.data.tenantId).toBe("string");
  });
});
