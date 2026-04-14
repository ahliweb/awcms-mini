import test from "node:test";
import assert from "node:assert/strict";

import { handleAuthLogin } from "../../src/auth/handlers/login.mjs";
import { hashPassword } from "../../src/auth/passwords.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    sessions: [],
    loginEvents: [],
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            if (table === "sessions") {
              state.sessions.push({
                created_at: values.created_at ?? "2026-01-01T00:00:00.000Z",
                ...values,
              });
            }

            if (table === "login_security_events") {
              state.loginEvents.push({
                occurred_at: values.occurred_at ?? "2026-01-01T00:00:00.000Z",
                ...values,
              });
            }
          },
        }),
      };
    },

    selectFrom(table) {
      const stateful = { where: [] };
      const source = table === "users" ? state.users : table === "sessions" ? state.sessions : state.loginEvents;

      const apply = () => {
        let rows = [...source];
        for (const clause of stateful.where) {
          if (clause.operator === "=" || clause.operator === "is") {
            rows = rows.filter((row) => row[clause.column] === clause.value);
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
        execute: async () => apply(),
        executeTakeFirst: async () => apply()[0],
      };

      return query;
    },

    updateTable(table) {
      const source = table === "users" ? state.users : state.sessions;
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
                const matches = updateState.where.every((clause) => row[clause.column] === clause.value);
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

function createFakeSession() {
  const values = new Map();
  return {
    set(key, value) {
      values.set(key, value);
    },
    get(key) {
      return values.get(key);
    },
  };
}

test("handleAuthLogin rejects invited users before activation", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({
    id: "user_invited",
    email: "invited@example.com",
    password_hash: hashPassword("very-secure-password"),
    status: "invited",
    deleted_at: null,
    must_reset_password: true,
    is_protected: false,
    email_verified: false,
    disabled: false,
  });

  const response = await handleAuthLogin({
    request: new Request("http://example.test/_emdash/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "invited@example.com", password: "very-secure-password" }),
    }),
    session: createFakeSession(),
    db: database,
  });

  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error.code, "ACCOUNT_NOT_ACTIVE");
  assert.equal(state.sessions.length, 0);
});

test("handleAuthLogin allows active users", async () => {
  const { database, state } = createFakeDatabase();
  const session = createFakeSession();
  state.users.push({
    id: "user_active",
    email: "active@example.com",
    password_hash: hashPassword("very-secure-password"),
    status: "active",
    deleted_at: null,
    must_reset_password: false,
    is_protected: false,
    email_verified: true,
    disabled: false,
    role: 10,
    name: "Active User",
    display_name: "Active User",
  });

  const response = await handleAuthLogin({
    request: new Request("http://example.test/_emdash/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "unit-test" },
      body: JSON.stringify({ email: "active@example.com", password: "very-secure-password" }),
    }),
    session,
    db: database,
  });

  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(state.sessions.length, 1);
  assert.deepEqual(session.get("user"), { id: "user_active" });
});
