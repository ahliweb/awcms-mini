import test from "node:test";
import assert from "node:assert/strict";

import { hashPassword } from "../../src/auth/passwords.mjs";
import { handleInviteActivation } from "../../src/auth/handlers/activate-invite.mjs";

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
    inviteTokens: [],
    auditLogs: [],
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            if (table === "audit_logs") {
              state.auditLogs.push({
                occurred_at: values.occurred_at ?? "2026-01-01T00:00:00.000Z",
                metadata: values.metadata ?? {},
                before_payload: values.before_payload ?? null,
                after_payload: values.after_payload ?? null,
                ...values,
              });
            }
          },
        }),
      };
    },

    selectFrom(table) {
      const stateful = { where: [] };
      const source = table === "users" ? state.users : table === "audit_logs" ? state.auditLogs : state.inviteTokens;

      const apply = () => {
        let rows = [...source];
        for (const clause of stateful.where) {
          if (clause.operator === "=" || clause.operator === "is") {
            rows = rows.filter((row) => row[clause.column] === clause.value);
          } else if (clause.operator === "is not") {
            rows = rows.filter((row) => row[clause.column] !== clause.value);
          }
        }
        return rows;
      };

      const query = {
        select: () => query,
        where: (column, operator, value) => {
          stateful.where.push({ column, operator, value });
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
      const source = table === "users" ? state.users : state.inviteTokens;
      const updateState = { values: undefined, where: [] };

      return {
        set: (values) => {
          updateState.values = values;
          const chain = {
            where: (column, operator, value) => {
              updateState.where.push({ column, operator, value });
              return chain;
            },
            execute: async () => {
              for (const row of source) {
                const matches = updateState.where.every((clause) => {
                  if (clause.operator === "=" || clause.operator === "is") return row[clause.column] === clause.value;
                  if (clause.operator === "is not") return row[clause.column] !== clause.value;
                  return false;
                });

                if (!matches) continue;

                for (const [key, nextValue] of Object.entries(updateState.values)) {
                  row[key] = nextValue !== null && typeof nextValue === "object" ? "2026-01-02T00:00:00.000Z" : nextValue;
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
          commit() {
            return { execute: async () => {} };
          },
          rollback() {
            return { execute: async () => {} };
          },
          savepoint() {
            return {
              execute: async () => ({
                ...executor,
                releaseSavepoint() {
                  return { execute: async () => {} };
                },
                rollbackToSavepoint() {
                  return { execute: async () => {} };
                },
              }),
            };
          },
        }),
      };
    },
  };

  return { database: executor, state };
}

function createInviteState(state) {
  const inviteId = "invite_token_1";
  const inviteSecret = "secret-token";
  const token = `${inviteId}.${inviteSecret}`;

  state.users.push({
    id: "user_invited",
    email: "invited@example.com",
    name: "Invited User",
    display_name: "Invited User",
    status: "invited",
    deleted_at: null,
    must_reset_password: true,
    password_hash: null,
    email_verified: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  state.inviteTokens.push({
    id: inviteId,
    user_id: "user_invited",
    token_hash: hashPassword(inviteSecret),
    expires_at: "2099-01-01T00:00:00.000Z",
    consumed_at: null,
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  });

  return token;
}

test("handleInviteActivation redirects with generic verification error when Turnstile validation fails", async () => {
  const { database, state } = createFakeDatabase();
  const token = createInviteState(state);
  const formData = new FormData();
  formData.set("token", token);
  formData.set("display_name", "Invited User");
  formData.set("password", "very-secure-password");
  formData.set("cf-turnstile-response", "bad-token");

  const response = await withTurnstileEnv(() =>
    withTurnstileStub({ success: false, "error-codes": ["timeout-or-duplicate"] }, () =>
      handleInviteActivation({
        db: database,
        request: new Request("http://example.test/api/activate", {
          method: "POST",
          body: formData,
        }),
      }),
    ),
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    `http://example.test/activate?token=${encodeURIComponent(token)}&error=REQUEST_VERIFICATION_FAILED`,
  );
  assert.equal(state.users[0].status, "invited");
  assert.equal(state.inviteTokens[0].consumed_at, null);
  assert.equal(state.auditLogs.length, 0);
});

test("handleInviteActivation activates invited users when Turnstile succeeds", async () => {
  const { database, state } = createFakeDatabase();
  const token = createInviteState(state);
  const formData = new FormData();
  formData.set("token", token);
  formData.set("display_name", "Updated Name");
  formData.set("password", "very-secure-password");
  formData.set("cf-turnstile-response", "good-token");

  const response = await withTurnstileEnv(() =>
    withTurnstileStub({ success: true, action: "invite_activation", hostname: "example.test" }, () =>
      handleInviteActivation({
        db: database,
        request: new Request("http://example.test/api/activate", {
          method: "POST",
          body: formData,
        }),
      }),
    ),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://example.test/activate?status=success");
  assert.equal(state.users[0].status, "active");
  assert.equal(state.users[0].email_verified, true);
  assert.equal(state.users[0].must_reset_password, false);
  assert.equal(state.users[0].display_name, "Updated Name");
  assert.equal(state.inviteTokens[0].consumed_at, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(state.auditLogs.map((entry) => entry.action), ["user.invite.activate"]);
});

test("handleInviteActivation still works without Turnstile configuration", async () => {
  const { database, state } = createFakeDatabase();
  const token = createInviteState(state);
  const formData = new FormData();
  formData.set("token", token);
  formData.set("display_name", "No Turnstile");
  formData.set("password", "very-secure-password");

  const response = await handleInviteActivation({
    db: database,
    request: new Request("http://example.test/api/activate", {
      method: "POST",
      body: formData,
    }),
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://example.test/activate?status=success");
  assert.equal(state.users[0].status, "active");
});
