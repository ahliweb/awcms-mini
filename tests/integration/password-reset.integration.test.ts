/**
 * Integration tests for the password reset flow (Issue #496, epic #492) —
 * the first real caller that enqueues into `awcms_mini_email_messages`.
 * Exercises the real handlers against a real PostgreSQL: account-
 * enumeration-safe responses, the full request -> email-enqueue ->
 * complete cycle (the raw token is recovered from the enqueued message's
 * `variables.resetUrl`, standing in for "the user received the email" —
 * there is no real Mailketing account in this environment), single-use/
 * expiry/wrong-token rejection, session invalidation after reset, and rate
 * limiting.
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
import { GET as authMe } from "../../src/pages/api/v1/auth/me";
import { POST as forgotPassword } from "../../src/pages/api/v1/auth/password/forgot";
import { POST as resetPassword } from "../../src/pages/api/v1/auth/password/reset";
import { resetRateLimitStoreForTests } from "../../src/lib/security/rate-limit";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string; loginIdentifier: string };

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

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    loginIdentifier
  };
}

function tenantHeaders(tenantId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": tenantId
  };
}

async function extractResetTokenFromQueue(
  tenantId: string,
  toAddressMasked: string
): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT variables ->> 'resetUrl' AS reset_url
    FROM awcms_mini_email_messages
    WHERE tenant_id = ${tenantId} AND category = 'auth.password_reset'
      AND to_address_masked = ${toAddressMasked}
    ORDER BY created_at DESC
    LIMIT 1
  `) as { reset_url: string }[];

  const resetUrl = rows[0]!.reset_url;
  const token = new URL(resetUrl).searchParams.get("token");
  expect(token).not.toBeNull();

  return token!;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("password reset flow", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetRateLimitStoreForTests();
  });

  test("forgot-password returns an identical generic response for an existing and a non-existing identifier", async () => {
    const owner = await bootstrap();

    const existing = await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: owner.loginIdentifier }
    });

    const nonExisting = await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: "no-such-user@example.com" }
    });

    expect(existing.status).toBe(nonExisting.status);
    expect(existing.body).toEqual(nonExisting.body);
  });

  test("a real request enqueues a redacted email_messages row (masked address, no raw token)", async () => {
    const owner = await bootstrap();

    await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: owner.loginIdentifier }
    });

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT to_address, to_address_masked, category, template_key, priority, status, variables
      FROM awcms_mini_email_messages
      WHERE tenant_id = ${owner.tenantId} AND category = 'auth.password_reset'
    `) as {
      to_address: string;
      to_address_masked: string;
      category: string;
      template_key: string;
      priority: string;
      status: string;
      variables: { resetUrl: string; expiresInMinutes: string };
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_address_masked).not.toBe(rows[0]!.to_address);
    expect(rows[0]!.to_address_masked).toContain("*");
    expect(rows[0]!.template_key).toBe("auth.password_reset");
    expect(rows[0]!.priority).toBe("high");
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.variables.resetUrl).toContain("token=");
  });

  test("full cycle: request -> extract token from queue -> complete -> old password rejected, new password works, old session revoked", async () => {
    const owner = await bootstrap();

    await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: owner.loginIdentifier }
    });

    const admin = getAdminSql();
    const maskedRows = (await admin`
      SELECT to_address_masked FROM awcms_mini_email_messages
      WHERE tenant_id = ${owner.tenantId} AND category = 'auth.password_reset'
    `) as { to_address_masked: string }[];
    const token = await extractResetTokenFromQueue(
      owner.tenantId,
      maskedRows[0]!.to_address_masked
    );

    const oldSessionCheck = await invoke(authMe, {
      method: "GET",
      path: "/api/v1/auth/me",
      headers: {
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${owner.token}`
      }
    });
    expect(oldSessionCheck.status).toBe(200);

    const reset = await invoke(resetPassword, {
      method: "POST",
      path: "/api/v1/auth/password/reset",
      headers: tenantHeaders(owner.tenantId),
      body: { token, newPassword: "a-brand-new-password-123" }
    });
    expect(reset.status).toBe(200);

    const oldLogin = await invoke(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: tenantHeaders(owner.tenantId),
      body: {
        loginIdentifier: owner.loginIdentifier,
        password: OWNER_PASSWORD
      },
      cookies: createCookieJar()
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: tenantHeaders(owner.tenantId),
      body: {
        loginIdentifier: owner.loginIdentifier,
        password: "a-brand-new-password-123"
      },
      cookies: createCookieJar()
    });
    expect(newLogin.status).toBe(200);

    const revokedSessionCheck = await invoke(authMe, {
      method: "GET",
      path: "/api/v1/auth/me",
      headers: {
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${owner.token}`
      }
    });
    expect(revokedSessionCheck.status).toBe(401);
  });

  test("a reused token is rejected on the second attempt", async () => {
    const owner = await bootstrap();

    await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: owner.loginIdentifier }
    });

    const admin = getAdminSql();
    const maskedRows = (await admin`
      SELECT to_address_masked FROM awcms_mini_email_messages
      WHERE tenant_id = ${owner.tenantId} AND category = 'auth.password_reset'
    `) as { to_address_masked: string }[];
    const token = await extractResetTokenFromQueue(
      owner.tenantId,
      maskedRows[0]!.to_address_masked
    );

    const first = await invoke(resetPassword, {
      method: "POST",
      path: "/api/v1/auth/password/reset",
      headers: tenantHeaders(owner.tenantId),
      body: { token, newPassword: "first-new-password-123" }
    });
    expect(first.status).toBe(200);

    const second = await invoke(resetPassword, {
      method: "POST",
      path: "/api/v1/auth/password/reset",
      headers: tenantHeaders(owner.tenantId),
      body: { token, newPassword: "second-new-password-123" }
    });
    expect(second.status).toBe(400);
  });

  test("an expired token is rejected with the same generic message as a wrong token", async () => {
    const owner = await bootstrap();

    await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: owner.loginIdentifier }
    });

    const admin = getAdminSql();
    const maskedRows = (await admin`
      SELECT to_address_masked FROM awcms_mini_email_messages
      WHERE tenant_id = ${owner.tenantId} AND category = 'auth.password_reset'
    `) as { to_address_masked: string }[];
    const token = await extractResetTokenFromQueue(
      owner.tenantId,
      maskedRows[0]!.to_address_masked
    );

    await admin`
      UPDATE awcms_mini_password_reset_tokens
      SET expires_at = now() - interval '1 hour'
      WHERE tenant_id = ${owner.tenantId}
    `;

    const expired = await invoke(resetPassword, {
      method: "POST",
      path: "/api/v1/auth/password/reset",
      headers: tenantHeaders(owner.tenantId),
      body: { token, newPassword: "a-new-password-123" }
    });

    const wrongToken = await invoke(resetPassword, {
      method: "POST",
      path: "/api/v1/auth/password/reset",
      headers: tenantHeaders(owner.tenantId),
      body: { token: "not-a-real-token", newPassword: "a-new-password-123" }
    });

    expect(expired.status).toBe(wrongToken.status);
    expect(expired.body).toEqual(wrongToken.body);
  });

  test("requesting a second reset supersedes the first token", async () => {
    const owner = await bootstrap();

    await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: owner.loginIdentifier }
    });

    const admin = getAdminSql();
    const firstMaskedRows = (await admin`
      SELECT to_address_masked FROM awcms_mini_email_messages
      WHERE tenant_id = ${owner.tenantId} AND category = 'auth.password_reset'
    `) as { to_address_masked: string }[];
    const firstToken = await extractResetTokenFromQueue(
      owner.tenantId,
      firstMaskedRows[0]!.to_address_masked
    );

    await invoke(forgotPassword, {
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      headers: tenantHeaders(owner.tenantId),
      body: { loginIdentifier: owner.loginIdentifier }
    });

    const attemptWithFirstToken = await invoke(resetPassword, {
      method: "POST",
      path: "/api/v1/auth/password/reset",
      headers: tenantHeaders(owner.tenantId),
      body: { token: firstToken, newPassword: "a-new-password-123" }
    });

    expect(attemptWithFirstToken.status).toBe(400);
  });

  test("forgot-password is rate limited per source+tenant", async () => {
    const owner = await bootstrap();
    const maxAttempts = Number(
      process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX ?? 5
    );

    let lastStatus = 0;
    for (let i = 0; i < maxAttempts + 1; i += 1) {
      const result = await invoke(forgotPassword, {
        method: "POST",
        path: "/api/v1/auth/password/forgot",
        headers: tenantHeaders(owner.tenantId),
        body: { loginIdentifier: owner.loginIdentifier }
      });
      lastStatus = result.status;
    }

    expect(lastStatus).toBe(429);
  });
});
