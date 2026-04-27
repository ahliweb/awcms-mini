import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../../../server/app.mjs";
import { EdgeAuthError } from "../../../src/services/edge-auth/service.mjs";

function makeRequest(path, options = {}) {
  return new Request(`http://localhost:3000${path}`, options);
}

function createAuthorizedOptions({ allowed = true } = {}) {
  return {
    resolveActor: () => ({ id: "user_1", status: "active", staff_level: 9 }),
    authorizationService: {
      async evaluate(input) {
        return {
          allowed,
          permission_code: input.context.permission_code,
          matched_rule: allowed ? "test-allow" : "test-deny",
          reason: allowed ? null : { code: "DENY_PERMISSION_MISSING" },
        };
      },
    },
    roleRepository: {
      async listRoles() {
        return [{ id: "role_admin", slug: "admin", name: "Admin" }];
      },
    },
    permissionRepository: {
      async listPermissions() {
        return [{ id: "perm_admin_roles_read", code: "admin.roles.read" }];
      },
    },
  };
}

function createBearerAuthOptions() {
  return {
    edgeAuthService: {
      async authenticateAccessToken(token) {
        assert.equal(token, "test-token");
        return {
          user: {
            id: "user_1",
            email: "admin@example.test",
            name: "Admin User",
            status: "active",
            staff_level: 9,
          },
          activeSession: {
            id: "session_1",
            trusted_device: false,
            expires_at: "2030-01-01T00:00:00.000Z",
            last_seen_at: "2026-01-01T00:00:00.000Z",
          },
          tokenClaims: {
            two_factor_satisfied: true,
          },
        };
      },
    },
    authorizationService: {
      async evaluate(input) {
        return {
          allowed: true,
          permission_code: input.context.permission_code,
          matched_rule: "test-allow",
          reason: null,
        };
      },
    },
    roleRepository: {
      async listRoles() {
        return [{ id: "role_admin", slug: "admin", name: "Admin" }];
      },
    },
    permissionRepository: {
      async listPermissions() {
        return [{ id: "perm_admin_roles_read", code: "admin.roles.read" }];
      },
    },
  };
}

function createLoginOptions({
  turnstileSuccess = true,
  loginResult,
  loginError,
} = {}) {
  return {
    runtimeConfig: {
      turnstile: {
        enabled: true,
        secretKey: "turnstile-secret",
        expectedHostnames: [],
      },
      edgeApi: {
        jwt: {
          enabled: true,
          secret: "edge-secret",
        },
      },
    },
    turnstileFetchImpl: async () => ({
      async json() {
        if (turnstileSuccess) {
          return { success: true, action: "login", hostname: "localhost" };
        }

        return { success: false, "error-codes": ["invalid-input-response"] };
      },
    }),
    edgeAuthService: {
      async issueTokenPairFromPassword(input) {
        if (loginError) {
          throw loginError;
        }

        return (
          loginResult ?? {
            tokenType: "Bearer",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            user: {
              id: "user_1",
              email: input.email,
              name: "Admin User",
            },
            session: {
              id: "session_1",
              trustedDevice: false,
              sessionStrength: "password",
              twoFactorSatisfied: false,
            },
          }
        );
      },
    },
  };
}

function createTwoFactorLoginOptions({ verifyResult, verifyError } = {}) {
  return {
    runtimeConfig: {
      turnstile: {
        enabled: true,
        secretKey: "turnstile-secret",
        expectedHostnames: [],
      },
      edgeApi: {
        jwt: {
          enabled: true,
          secret: "edge-secret",
        },
      },
    },
    turnstileFetchImpl: async () => ({
      async json() {
        return { success: true, action: "login", hostname: "localhost" };
      },
    }),
    edgeAuthService: {
      async issueTokenPairFromPassword(input) {
        if (!input.code && !input.recoveryCode) {
          throw new EdgeAuthError(
            "TWO_FACTOR_REQUIRED",
            "Two-factor code is required.",
            403,
          );
        }

        if (verifyError) {
          throw verifyError;
        }

        return (
          verifyResult ?? {
            tokenType: "Bearer",
            accessToken: "two-factor-access-token",
            refreshToken: "two-factor-refresh-token",
            user: {
              id: "user_1",
              email: input.email,
              name: "Admin User",
            },
            session: {
              id: "session_1",
              trustedDevice: false,
              sessionStrength: "two_factor",
              twoFactorSatisfied: true,
            },
          }
        );
      },
    },
  };
}

function createLogoutOptions({ activeSession = true } = {}) {
  return {
    edgeAuthService: {
      async authenticateAccessToken(token) {
        assert.equal(token, "test-token");
        return {
          user: {
            id: "user_1",
            email: "admin@example.test",
            name: "Admin User",
            status: "active",
            staff_level: 9,
          },
          activeSession: activeSession
            ? {
                id: "session_1",
                trusted_device: false,
                expires_at: "2030-01-01T00:00:00.000Z",
                last_seen_at: "2026-01-01T00:00:00.000Z",
              }
            : null,
          tokenClaims: {
            two_factor_satisfied: true,
          },
        };
      },
      async revokeSessionTokens(sessionId) {
        assert.equal(sessionId, "session_1");
      },
    },
    sessionService: {
      async revokeSession(sessionId) {
        assert.equal(sessionId, "session_1");
        return {
          id: "session_1",
          revoked_at: "2026-02-01T00:00:00.000Z",
        };
      },
    },
  };
}

function createRefreshOptions({ refreshResult, refreshError } = {}) {
  return {
    edgeAuthService: {
      async refreshTokenPair(input) {
        assert.equal(input.refreshToken, "refresh-token");

        if (refreshError) {
          throw refreshError;
        }

        return (
          refreshResult ?? {
            tokenType: "Bearer",
            accessToken: "next-access-token",
            refreshToken: "next-refresh-token",
            user: {
              id: "user_1",
              email: "admin@example.test",
              name: "Admin User",
            },
            session: {
              id: "session_1",
              trustedDevice: false,
              sessionStrength: "password",
              twoFactorSatisfied: false,
            },
          }
        );
      },
    },
  };
}

function createTwoFactorOptions() {
  return {
    edgeAuthService: {
      async authenticateAccessToken(token) {
        assert.equal(token, "test-token");
        return {
          user: {
            id: "user_1",
            email: "admin@example.test",
            name: "Admin User",
            status: "active",
            staff_level: 9,
          },
          activeSession: {
            id: "session_1",
            trusted_device: false,
            expires_at: "2030-01-01T00:00:00.000Z",
            last_seen_at: "2026-01-01T00:00:00.000Z",
          },
          tokenClaims: {
            two_factor_satisfied: true,
          },
        };
      },
    },
    twoFactorService: {
      async beginEnrollment(input) {
        assert.equal(input.user_id, "user_1");
        return {
          credentialId: "totp_1",
          manualKey: "MANUALKEY123",
          otpauthUrl: "otpauth://totp/AWCMS%20Mini:admin@example.test",
          verified: false,
        };
      },
      async verifyEnrollment(input) {
        assert.equal(input.user_id, "user_1");
        assert.equal(input.code, "123456");
        return {
          credential: {
            verified_at: "2026-03-01T00:00:00.000Z",
          },
          recoveryCodes: ["RECOVERY1", "RECOVERY2"],
        };
      },
      async regenerateRecoveryCodes(input) {
        assert.equal(input.user_id, "user_1");
        return {
          regeneratedAt: "2026-03-02T00:00:00.000Z",
          recoveryCodes: ["NEWRECOVERY1", "NEWRECOVERY2"],
        };
      },
    },
  };
}

test("GET /health returns a JSON health check response", async () => {
  const app = createApp();
  const res = await app.fetch(makeRequest("/health"));

  assert.ok([200, 503].includes(res.status), `unexpected status ${res.status}`);
  assert.ok(
    res.headers.get("content-type")?.startsWith("application/json"),
    `unexpected content-type: ${res.headers.get("content-type")}`,
  );

  const body = await res.json();
  assert.equal(typeof body.ok, "boolean");
  assert.equal(body.service, "awcms-mini");
  assert.ok(body.checks?.database !== undefined);
  assert.ok(typeof body.timestamp === "string");
});

test("GET /health sets X-Request-Id response header", async () => {
  const app = createApp();
  const res = await app.fetch(makeRequest("/health"));
  assert.ok(res.headers.get("x-request-id"), "X-Request-Id header missing");
});

test("GET /health echoes X-Request-Id from request when provided", async () => {
  const app = createApp();
  const res = await app.fetch(
    makeRequest("/health", { headers: { "x-request-id": "test-id-abc" } }),
  );
  assert.equal(res.headers.get("x-request-id"), "test-id-abc");
});

test("GET /health sets security headers", async () => {
  const app = createApp();
  const res = await app.fetch(makeRequest("/health"));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("GET /api/v1 returns version metadata", async () => {
  const app = createApp();
  const res = await app.fetch(makeRequest("/api/v1"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, "v1");
  assert.equal(body.service, "awcms-mini");
});

test("POST /api/v1/auth/login returns 501 not-yet-implemented", async () => {
  const app = createApp(createLoginOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "secret-password",
        turnstileToken: "turnstile-token",
      }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.tokenType, "Bearer");
  assert.equal(body.data.user.email, "admin@example.test");
});

test("GET /nonexistent returns 404", async () => {
  const app = createApp();
  const res = await app.fetch(makeRequest("/nonexistent-route-xyz"));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error?.code, "NOT_FOUND");
});

test("GET /api/v1/roles requires authentication", async () => {
  const app = createApp({
    roleRepository: {
      async listRoles() {
        return [];
      },
    },
  });
  const res = await app.fetch(makeRequest("/api/v1/roles"));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error?.code, "UNAUTHENTICATED");
});

test("GET /api/v1/roles returns role catalog when injected actor is allowed", async () => {
  const app = createApp(createAuthorizedOptions());
  const res = await app.fetch(makeRequest("/api/v1/roles"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data[0].slug, "admin");
});

test("GET /api/v1/permissions returns 403 when ABAC denies", async () => {
  const app = createApp(createAuthorizedOptions({ allowed: false }));
  const res = await app.fetch(makeRequest("/api/v1/permissions"));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error?.code, "FORBIDDEN");
  assert.equal(body.error?.details?.permissionCode, "admin.permissions.read");
});

test("GET /api/v1/auth/me returns current bearer-authenticated user", async () => {
  const app = createApp(createBearerAuthOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/auth/me", {
      headers: { authorization: "Bearer test-token" },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.user.id, "user_1");
  assert.equal(body.data.user.email, "admin@example.test");
  assert.equal(body.data.session.id, "session_1");
});

test("GET /api/v1/roles uses bearer-authenticated actor for ABAC", async () => {
  const app = createApp(createBearerAuthOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/roles", {
      headers: { authorization: "Bearer test-token" },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data[0].slug, "admin");
});

test("POST /api/v1/auth/login returns 403 when Turnstile validation fails", async () => {
  const app = createApp(createLoginOptions({ turnstileSuccess: false }));
  const res = await app.fetch(
    makeRequest("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "secret-password",
        turnstileToken: "invalid-turnstile-token",
      }),
    }),
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, "TURNSTILE_INVALID");
});

test("POST /api/v1/auth/login returns edge-auth errors", async () => {
  const app = createApp(
    createLoginOptions({
      loginError: new EdgeAuthError(
        "INVALID_CREDENTIALS",
        "Invalid email or password.",
        401,
      ),
    }),
  );
  const res = await app.fetch(
    makeRequest("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "wrong-password",
        turnstileToken: "turnstile-token",
      }),
    }),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "INVALID_CREDENTIALS");
});

test("POST /api/v1/auth/login returns explicit two-factor challenge payload", async () => {
  const app = createApp(createTwoFactorLoginOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "secret-password",
        turnstileToken: "turnstile-token",
      }),
    }),
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, "TWO_FACTOR_REQUIRED");
  assert.equal(body.data.requiresTwoFactor, true);
});

test("POST /api/v1/auth/logout returns 401 when not authenticated", async () => {
  const app = createApp();
  const res = await app.fetch(
    makeRequest("/api/v1/auth/logout", {
      method: "POST",
    }),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "NOT_AUTHENTICATED");
});

test("POST /api/v1/auth/logout revokes current bearer-authenticated session", async () => {
  const app = createApp(createLogoutOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/auth/logout", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.success, true);
  assert.equal(body.data.session.id, "session_1");
  assert.equal(body.data.session.revokedAt, "2026-02-01T00:00:00.000Z");
});

test("POST /api/v1/auth/refresh returns a rotated token pair", async () => {
  const app = createApp(createRefreshOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-token" }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.accessToken, "next-access-token");
  assert.equal(body.data.refreshToken, "next-refresh-token");
});

test("POST /api/v1/auth/refresh returns edge-auth refresh errors", async () => {
  const app = createApp(
    createRefreshOptions({
      refreshError: new EdgeAuthError(
        "INVALID_REFRESH_TOKEN",
        "Refresh token is invalid.",
        401,
      ),
    }),
  );
  const res = await app.fetch(
    makeRequest("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-token" }),
    }),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "INVALID_REFRESH_TOKEN");
});

test("POST /api/v1/security/2fa/setup requires authentication", async () => {
  const app = createApp();
  const res = await app.fetch(
    makeRequest("/api/v1/security/2fa/setup", {
      method: "POST",
    }),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "NOT_AUTHENTICATED");
});

test("POST /api/v1/security/2fa/setup returns enrollment payload", async () => {
  const app = createApp(createTwoFactorOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/security/2fa/setup", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.credentialId, "totp_1");
  assert.equal(body.data.verified, false);
});

test("POST /api/v1/security/2fa/confirm returns verification payload", async () => {
  const app = createApp(createTwoFactorOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/security/2fa/confirm", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "123456" }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.success, true);
  assert.equal(body.data.verifiedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(body.data.recoveryCodes.length, 2);
});

test("POST /api/v1/security/2fa/recovery-codes/regenerate requires authentication", async () => {
  const app = createApp();
  const res = await app.fetch(
    makeRequest("/api/v1/security/2fa/recovery-codes/regenerate", {
      method: "POST",
    }),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "NOT_AUTHENTICATED");
});

test("POST /api/v1/security/2fa/recovery-codes/regenerate returns a new recovery code set", async () => {
  const app = createApp(createTwoFactorOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/security/2fa/recovery-codes/regenerate", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.success, true);
  assert.equal(body.data.regeneratedAt, "2026-03-02T00:00:00.000Z");
  assert.equal(body.data.recoveryCodes.length, 2);
});

test("POST /api/v1/auth/login/verify-2fa returns token pair after second factor", async () => {
  const app = createApp(createTwoFactorLoginOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/auth/login/verify-2fa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "secret-password",
        code: "123456",
      }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.accessToken, "two-factor-access-token");
  assert.equal(body.data.session.twoFactorSatisfied, true);
});

test("POST /api/v1/auth/login/verify-2fa requires code or recovery code", async () => {
  const app = createApp(createTwoFactorLoginOptions());
  const res = await app.fetch(
    makeRequest("/api/v1/auth/login/verify-2fa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "secret-password",
      }),
    }),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "INVALID_CODE");
});
