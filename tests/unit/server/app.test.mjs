import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../../../server/app.mjs";

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
  const app = createApp();
  const res = await app.fetch(
    makeRequest("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(res.status, 501);
  const body = await res.json();
  assert.equal(body.error?.code, "NOT_IMPLEMENTED");
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
