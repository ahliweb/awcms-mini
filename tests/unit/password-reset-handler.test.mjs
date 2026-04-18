import test from "node:test";
import assert from "node:assert/strict";

import { handlePasswordResetConsume, handlePasswordResetRequest } from "../../src/auth/handlers/password-reset.mjs";

const originalFetch = globalThis.fetch;

function withTurnstileEnv(callback) {
  const previousSecret = process.env.TURNSTILE_SECRET_KEY;
  const previousSiteUrl = process.env.SITE_URL;

  process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";
  process.env.SITE_URL = "http://example.test";

  return Promise.resolve(callback()).finally(() => {
    if (previousSecret === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY;
    } else {
      process.env.TURNSTILE_SECRET_KEY = previousSecret;
    }

    if (previousSiteUrl === undefined) {
      delete process.env.SITE_URL;
    } else {
      process.env.SITE_URL = previousSiteUrl;
    }
  });
}

function withTurnstileStub(result, callback) {
  globalThis.fetch = async () => ({
    async json() {
      return result;
    },
  });

  return Promise.resolve(callback()).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function createFakeDatabase() {
  const state = {
    users: [],
    password_reset_tokens: [],
    sessions: [],
    audit_logs: [],
    security_events: [],
    rate_limit_counters: [],
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            const items = Array.isArray(values) ? values : [values];

            for (const item of items) {
              state[table].push({
                created_at: item.created_at ?? "2026-01-01T00:00:00.000Z",
                used_at: item.used_at ?? null,
                verified_at: item.verified_at ?? null,
                last_used_at: item.last_used_at ?? null,
                disabled_at: item.disabled_at ?? null,
                details_json: item.details_json ?? {},
                ...item,
              });
            }

            if (table === "rate_limit_counters") {
              for (const item of items) {
                state.rate_limit_counters.push({
                  created_at: item.created_at ?? "2026-01-01T00:00:00.000Z",
                  updated_at: item.updated_at ?? "2026-01-01T00:00:00.000Z",
                  ...item,
                });
              }
            }
          },
        }),
      };
    },

    selectFrom(table) {
      const source = state[table];
      const local = { where: [], orderBy: [], limit: undefined, offset: undefined };
      const apply = () => {
        let rows = [...source];
        for (const clause of local.where) {
          if (clause.operator === "=" || clause.operator === "is") rows = rows.filter((row) => row[clause.column] === clause.value);
          else if (clause.operator === "is not") rows = rows.filter((row) => row[clause.column] !== clause.value);
        }
        rows.sort((a, b) => {
          for (const clause of local.orderBy) {
            const cmp = String(a[clause.column] ?? "").localeCompare(String(b[clause.column] ?? ""));
            if (cmp) return clause.direction === "desc" ? -cmp : cmp;
          }
          return 0;
        });
        if (local.offset !== undefined) rows = rows.slice(local.offset);
        if (local.limit !== undefined) rows = rows.slice(0, local.limit);
        return rows;
      };
      const query = {
        select: () => query,
        where: (column, operator, value) => { local.where.push({ column, operator, value }); return query; },
        orderBy: (column, direction = "asc") => { local.orderBy.push({ column, direction }); return query; },
        limit: (limit) => { local.limit = limit; return query; },
        offset: (offset) => { local.offset = offset; return query; },
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
            where: (column, operator, value) => { local.where.push({ column, operator, value }); return chain; },
            execute: async () => {
              for (const row of source) {
                const matches = local.where.every((clause) => {
                  if (clause.operator === "=" || clause.operator === "is") return row[clause.column] === clause.value;
                  if (clause.operator === "is not") return row[clause.column] !== clause.value;
                  return false;
                });
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

    deleteFrom(table) {
      const source = state[table];
      const local = { where: [] };
      const chain = {
        where(column, operator, value) {
          local.where.push({ column, operator, value });
          return chain;
        },
        execute: async () => {
          for (let index = source.length - 1; index >= 0; index -= 1) {
            const row = source[index];
            const matches = local.where.every((clause) => {
              if (clause.operator === "=" || clause.operator === "is") return row[clause.column] === clause.value;
              if (clause.operator === "<=") return String(row[clause.column]) <= String(clause.value);
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

test("handlePasswordResetRequest returns a generic success response without exposing a token", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null, must_reset_password: false, password_hash: "old_hash" });

  const response = await withTurnstileEnv(() =>
    withTurnstileStub({ success: true, action: "password_reset_request", hostname: "example.test" }, () =>
      handlePasswordResetRequest({
        db: database,
        request: new Request("http://example.test/api/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "user@example.com", turnstileToken: "token" }),
        }),
      }),
    ),
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.deepEqual(payload, {
    success: true,
    message: "If the account is eligible for password reset, follow the configured recovery channel.",
  });
  assert.equal("token" in payload, false);
  assert.equal(state.password_reset_tokens.length, 1);
});

test("handlePasswordResetRequest does not reveal whether an account exists", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null, must_reset_password: false, password_hash: "old_hash" });

  const response = await withTurnstileEnv(() =>
    withTurnstileStub({ success: true, action: "password_reset_request", hostname: "example.test" }, () =>
      handlePasswordResetRequest({
        db: database,
        request: new Request("http://example.test/api/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "missing@example.com", turnstileToken: "token" }),
        }),
      }),
    ),
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.deepEqual(payload, {
    success: true,
    message: "If the account is eligible for password reset, follow the configured recovery channel.",
  });
  assert.equal(state.password_reset_tokens.length, 0);
});

test("handlePasswordResetConsume keeps token validation errors generic", async () => {
  const { database } = createFakeDatabase();

  const response = await handlePasswordResetConsume({
    db: database,
    request: new Request("http://example.test/api/reset-password?mode=consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invalid-token", password: "new-password-123" }),
    }),
  });

  assert.equal(response.status, 400);

  const payload = await response.json();
  assert.deepEqual(payload, {
    error: {
      code: "INVALID_TOKEN",
      message: "Password reset token is invalid.",
    },
  });
});

test("handlePasswordResetRequest rejects requests when Turnstile validation fails", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null, must_reset_password: false, password_hash: "old_hash" });

  const response = await withTurnstileEnv(() =>
    withTurnstileStub({ success: false, "error-codes": ["timeout-or-duplicate"] }, () =>
      handlePasswordResetRequest({
        db: database,
        request: new Request("http://example.test/api/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "user@example.com", turnstileToken: "bad-token" }),
        }),
      }),
    ),
  );

  const payload = await response.json();
  assert.equal(response.status, 403);
  assert.equal(payload.error.code, "TURNSTILE_INVALID");
  assert.equal(state.password_reset_tokens.length, 0);
});
