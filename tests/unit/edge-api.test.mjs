import test from "node:test";
import assert from "node:assert/strict";

import { handleEdgeHealthGet, handleEdgeHealthOptions } from "../../src/api/edge/health.mjs";
import { handleEdgeSessionGet, handleEdgeSessionOptions, handleEdgeSessionPost } from "../../src/api/edge/session.mjs";
import { handleEdgeTokenPost } from "../../src/api/edge/token.mjs";
import { hashPassword } from "../../src/auth/passwords.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    sessions: [],
    edge_api_refresh_tokens: [],
    audit_logs: [],
    login_security_events: [],
    security_events: [],
    rate_limit_counters: [],
    user_roles: [],
    role_permissions: [],
    permissions: [],
    roles: [],
    job_levels: [],
    job_titles: [],
    user_jobs: [],
    regions: [],
    user_region_assignments: [],
    administrative_regions: [],
    user_administrative_region_assignments: [],
    totp_credentials: [],
    recovery_codes: [],
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            const rows = Array.isArray(values) ? values : [values];

            for (const row of rows) {
              if (!state[table]) {
                continue;
              }

              state[table].push({
                created_at: row.created_at ?? "2026-01-01T00:00:00.000Z",
                occurred_at: row.occurred_at ?? "2026-01-01T00:00:00.000Z",
                metadata: row.metadata ?? {},
                before_payload: row.before_payload ?? null,
                after_payload: row.after_payload ?? null,
                ...row,
              });
            }
          },
        }),
      };
    },
    deleteFrom(table) {
      const source = state[table];
      const local = { where: [] };
      const chain = {
        where(column, operator, value) {
          local.where.push({ column, operator, value });
          return chain;
        },
        execute: async () => {
          if (!source) {
            return;
          }

          for (let index = source.length - 1; index >= 0; index -= 1) {
            const row = source[index];
            const matches = local.where.every((clause) => {
              if (clause.operator === "=" || clause.operator === "is") {
                return row[clause.column] === clause.value;
              }

              if (clause.operator === "<=") {
                return row[clause.column] <= clause.value;
              }

              if (clause.operator === "in") {
                return clause.value.includes(row[clause.column]);
              }

              return false;
            });

            if (matches) {
              source.splice(index, 1);
            }
          }
        },
      };

      return chain;
    },
    selectFrom(table) {
      const source = state[table];
      const local = { where: [] };
      const apply = () => {
        let rows = [...source];
        for (const clause of local.where) {
          if (clause.operator === "=" || clause.operator === "is") {
            rows = rows.filter((row) => row[clause.column] === clause.value);
          } else if (clause.operator === "<=") {
            rows = rows.filter((row) => row[clause.column] <= clause.value);
          } else if (clause.operator === "in") {
            rows = rows.filter((row) => clause.value.includes(row[clause.column]));
          }
        }
        return rows;
      };
      const query = {
        select: () => query,
        where: (column, operator, value) => {
          local.where.push({ column, operator, value });
          return query;
        },
        orderBy: () => query,
        limit: () => query,
        offset: () => query,
        execute: async () => apply(),
        executeTakeFirst: async () => apply()[0],
      };
      return query;
    },
    updateTable(table) {
      const source = state[table];
      const local = { values: undefined, where: [] };
      return {
        set: (values) => {
          local.values = values;
          const chain = {
            where: (column, operator, value) => {
              local.where.push({ column, operator, value });
              return chain;
            },
            execute: async () => {
              for (const row of source) {
                const matches = local.where.every((clause) => row[clause.column] === clause.value);
                if (!matches) continue;
                for (const [key, nextValue] of Object.entries(local.values)) {
                  row[key] = typeof nextValue === "object" && nextValue !== null ? "2026-01-02T00:00:00.000Z" : nextValue;
                }
              }
            },
          };
          return chain;
        },
      };
    },
    startTransaction() {
      return {
        execute: async () => ({
          ...executor,
          commit() { return { execute: async () => {} }; },
          rollback() { return { execute: async () => {} }; },
          savepoint() {
            return {
              execute: async () => ({
                ...executor,
                releaseSavepoint() { return { execute: async () => {} }; },
                rollbackToSavepoint() { return { execute: async () => {} }; },
              }),
            };
          },
        }),
      };
    },
  };

  return { database: executor, state };
}

function seedEdgeApiMember(state, overrides = {}) {
  state.users.push({
    id: "user_1",
    email: "user@example.com",
    display_name: "User Example",
    name: "User Example",
    avatar_url: "https://example.test/avatar.png",
    password_hash: hashPassword("secret-password"),
    deleted_at: null,
    status: "active",
    is_protected: false,
    must_reset_password: false,
    ...overrides.user,
  });
  state.roles = [{ id: "role_member", slug: "member", staff_level: 2, deleted_at: null }];
  state.user_roles = [{ id: "assignment_1", user_id: "user_1", role_id: "role_member", expires_at: null, is_primary: true, assigned_at: "2026-04-18T00:00:00.000Z" }];
  state.permissions = [
    { id: "perm_edge_api_session_read", code: "edge.api_session.read", domain: "edge", resource: "api_session", action: "read", is_protected: false },
    { id: "perm_edge_api_session_revoke", code: "edge.api_session.revoke", domain: "edge", resource: "api_session", action: "revoke", is_protected: false },
  ];
  state.role_permissions = [
    { role_id: "role_member", permission_id: "perm_edge_api_session_read" },
    { role_id: "role_member", permission_id: "perm_edge_api_session_revoke" },
  ];
}

async function withEdgeJwtConfig(callback) {
  const previousSecret = process.env.EDGE_API_JWT_SECRET;
  const previousTrustedProxyMode = process.env.TRUSTED_PROXY_MODE;
  process.env.EDGE_API_JWT_SECRET = "test-edge-secret";
  process.env.TRUSTED_PROXY_MODE = "direct";

  try {
    await callback();
  } finally {
    if (previousSecret === undefined) delete process.env.EDGE_API_JWT_SECRET;
    else process.env.EDGE_API_JWT_SECRET = previousSecret;

    if (previousTrustedProxyMode === undefined) delete process.env.TRUSTED_PROXY_MODE;
    else process.env.TRUSTED_PROXY_MODE = previousTrustedProxyMode;
  }
}

function createFakeSession(values = {}) {
  const store = new Map(Object.entries(values));
  return {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
    },
    destroy() {
      store.clear();
    },
    snapshot() {
      return Object.fromEntries(store.entries());
    },
  };
}

test("edge health endpoint returns a versioned JSON health payload", async () => {
  const response = await handleEdgeHealthGet({
    request: new Request("http://example.test/api/v1/health", { headers: { Accept: "application/json" } }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, "v1");
});

test("edge health preflight returns explicit CORS metadata for allowed origins", async () => {
  const previousOrigins = process.env.EDGE_API_ALLOWED_ORIGINS;
  process.env.EDGE_API_ALLOWED_ORIGINS = "https://mobile.example.com";

  try {
    const response = await handleEdgeHealthOptions({
      request: new Request("http://example.test/api/v1/health", {
        method: "OPTIONS",
        headers: { Origin: "https://mobile.example.com" },
      }),
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://mobile.example.com");
  } finally {
    if (previousOrigins === undefined) delete process.env.EDGE_API_ALLOWED_ORIGINS;
    else process.env.EDGE_API_ALLOWED_ORIGINS = previousOrigins;
  }
});

test("edge session endpoint requires an authenticated identity session", async () => {
  const { database } = createFakeDatabase();
  const response = await handleEdgeSessionGet({
    request: new Request("http://example.test/api/v1/session", { headers: { Accept: "application/json" } }),
    session: createFakeSession(),
    db: database,
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "NOT_AUTHENTICATED");
});

test("edge session endpoint returns the current session and user profile", async () => {
  const { database, state } = createFakeDatabase();
  seedEdgeApiMember(state);
  state.sessions.push({
    id: "session_1",
    user_id: "user_1",
    trusted_device: true,
    last_seen_at: "2026-04-18T00:00:00.000Z",
    expires_at: "2026-05-18T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-04-18T00:00:00.000Z",
  });

  const response = await handleEdgeSessionGet({
    request: new Request("http://example.test/api/v1/session", { headers: { Accept: "application/json" } }),
    session: createFakeSession({ user: { id: "user_1" }, identitySession: { id: "session_1" } }),
    db: database,
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.id, "user_1");
  assert.equal(body.session.id, "session_1");
  assert.equal(body.session.trustedDevice, true);
});

test("edge session revoke endpoint enforces JSON requests and revokes the active session", async () => {
  const { database, state } = createFakeDatabase();
  seedEdgeApiMember(state, {
    user: { avatar_url: null },
  });
  state.sessions.push({
    id: "session_1",
    user_id: "user_1",
    trusted_device: false,
    last_seen_at: null,
    expires_at: "2026-05-18T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-04-18T00:00:00.000Z",
  });

  const unsupported = await handleEdgeSessionPost({
    request: new Request("http://example.test/api/v1/session", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "text/plain" },
      body: "bad",
    }),
    session: createFakeSession({ user: { id: "user_1" }, identitySession: { id: "session_1" } }),
    db: database,
  });
  assert.equal(unsupported.status, 415);

  const session = createFakeSession({ user: { id: "user_1" }, identitySession: { id: "session_1" } });
  const revoked = await handleEdgeSessionPost({
    request: new Request("http://example.test/api/v1/session", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke_current_session" }),
    }),
    session,
    db: database,
  });

  assert.equal(revoked.status, 200);
  const body = await revoked.json();
  assert.equal(body.success, true);
  assert.equal(state.sessions[0].revoked_at, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(session.snapshot(), {});
  assert.equal(state.audit_logs.some((entry) => entry.action === "session.revoke"), true);
});

test("edge session endpoint denies callers missing canonical edge permissions", async () => {
  const { database, state } = createFakeDatabase();
  seedEdgeApiMember(state, {
    user: { avatar_url: null },
  });
  state.permissions = [];
  state.role_permissions = [];
  state.sessions.push({
    id: "session_1",
    user_id: "user_1",
    trusted_device: true,
    last_seen_at: "2026-04-18T00:00:00.000Z",
    expires_at: "2026-05-18T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-04-18T00:00:00.000Z",
  });

  const response = await handleEdgeSessionGet({
    request: new Request("http://example.test/api/v1/session", { headers: { Accept: "application/json" } }),
    session: createFakeSession({ user: { id: "user_1" }, identitySession: { id: "session_1" } }),
    db: database,
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "FORBIDDEN");
});

test("edge token password grant issues bearer credentials for external clients", async () => {
  await withEdgeJwtConfig(async () => {
    const { database, state } = createFakeDatabase();
    seedEdgeApiMember(state);

    const response = await handleEdgeTokenPost({
      request: new Request("http://example.test/api/v1/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          email: "user@example.com",
          password: "secret-password",
        }),
      }),
      db: database,
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tokenType, "Bearer");
    assert.equal(typeof body.accessToken, "string");
    assert.equal(typeof body.refreshToken, "string");
    assert.equal(state.sessions.length, 1);
    assert.equal(state.edge_api_refresh_tokens.length, 1);

    const sessionResponse = await handleEdgeSessionGet({
      request: new Request("http://example.test/api/v1/session", {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${body.accessToken}`,
        },
      }),
      session: createFakeSession(),
      db: database,
    });

    assert.equal(sessionResponse.status, 200);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionBody.user.id, "user_1");
    assert.equal(sessionBody.session.id, state.sessions[0].id);
  });
});

test("edge token password grant enforces enrolled two-factor verification", async () => {
  await withEdgeJwtConfig(async () => {
    const { database, state } = createFakeDatabase();
    seedEdgeApiMember(state);
    state.totp_credentials.push({
      id: "totp_1",
      user_id: "user_1",
      secret_encrypted: "ignored-for-test",
      issuer: "AWCMS Mini",
      label: "user@example.com",
      verified_at: "2026-04-18T00:00:00.000Z",
      last_used_at: null,
      disabled_at: null,
      created_at: "2026-04-18T00:00:00.000Z",
    });

    const response = await handleEdgeTokenPost({
      request: new Request("http://example.test/api/v1/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          email: "user@example.com",
          password: "secret-password",
        }),
      }),
      db: database,
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, "TWO_FACTOR_REQUIRED");
    assert.equal(state.sessions.length, 0);
    assert.equal(state.edge_api_refresh_tokens.length, 0);
  });
});

test("edge token refresh grant rotates opaque refresh tokens", async () => {
  await withEdgeJwtConfig(async () => {
    const { database, state } = createFakeDatabase();
    seedEdgeApiMember(state);

    const passwordResponse = await handleEdgeTokenPost({
      request: new Request("http://example.test/api/v1/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          email: "user@example.com",
          password: "secret-password",
        }),
      }),
      db: database,
    });
    const passwordBody = await passwordResponse.json();

    const refreshResponse = await handleEdgeTokenPost({
      request: new Request("http://example.test/api/v1/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: passwordBody.refreshToken,
        }),
      }),
      db: database,
    });

    assert.equal(refreshResponse.status, 200);
    const refreshBody = await refreshResponse.json();
    assert.notEqual(refreshBody.refreshToken, passwordBody.refreshToken);
    assert.equal(state.edge_api_refresh_tokens.length, 2);
    assert.equal(typeof state.edge_api_refresh_tokens[0].used_at, "string");
    assert.equal(typeof state.edge_api_refresh_tokens[0].replaced_by_token_id, "string");
  });
});

test("edge session revoke with bearer auth also revokes stored refresh tokens", async () => {
  await withEdgeJwtConfig(async () => {
    const { database, state } = createFakeDatabase();
    seedEdgeApiMember(state);

    const tokenResponse = await handleEdgeTokenPost({
      request: new Request("http://example.test/api/v1/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          email: "user@example.com",
          password: "secret-password",
        }),
      }),
      db: database,
    });
    const tokenBody = await tokenResponse.json();

    const revokeResponse = await handleEdgeSessionPost({
      request: new Request("http://example.test/api/v1/session", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${tokenBody.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "revoke_current_session" }),
      }),
      session: createFakeSession(),
      db: database,
    });

    assert.equal(revokeResponse.status, 200);
    assert.equal(state.sessions[0].revoked_at, "2026-01-02T00:00:00.000Z");
    assert.equal(state.edge_api_refresh_tokens[0].revoked_at, "2026-01-02T00:00:00.000Z");
  });
});
