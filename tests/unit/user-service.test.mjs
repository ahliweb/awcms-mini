import test from "node:test";
import assert from "node:assert/strict";

import { createUserService } from "../../src/services/users/service.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    sessions: [],
    loginEvents: [],
    transactions: 0,
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            if (table === "users") {
              state.users.push({
                created_at: values.created_at ?? "2026-01-01T00:00:00.000Z",
                updated_at: values.updated_at ?? "2026-01-01T00:00:00.000Z",
                deleted_at: values.deleted_at ?? null,
                deleted_by_user_id: values.deleted_by_user_id ?? null,
                delete_reason: values.delete_reason ?? null,
                ...values,
              });
            }

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
      const stateful = {
        where: [],
        limit: undefined,
        offset: undefined,
      };

      const source =
        table === "users" ? state.users : table === "sessions" ? state.sessions : state.loginEvents;

      const apply = () => {
        let rows = [...source];

        for (const clause of stateful.where) {
          if (clause.operator === "=" || clause.operator === "is") {
            rows = rows.filter((row) => row[clause.column] === clause.value);
          } else if (clause.operator === "is not") {
            rows = rows.filter((row) => row[clause.column] !== clause.value);
          }
        }

        if (stateful.offset !== undefined) rows = rows.slice(stateful.offset);
        if (stateful.limit !== undefined) rows = rows.slice(0, stateful.limit);

        return rows;
      };

      const query = {
        select: () => query,
        where: (column, operator, value) => {
          stateful.where.push({ column, operator, value });
          return query;
        },
        orderBy: () => query,
        limit: (limit) => {
          stateful.limit = limit;
          return query;
        },
        offset: (offset) => {
          stateful.offset = offset;
          return query;
        },
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
        execute: async () => {
          state.transactions += 1;
          return {
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
          };
        },
      };
    },
  };

  return { database: executor, state };
}

test("user service creates and invites users with explicit lifecycle states", async () => {
  const { database, state } = createFakeDatabase();
  const service = createUserService({ database });

  const created = await service.createUser({
    id: "user_1",
    email: "active@example.com",
  });

  const invited = await service.inviteUser({
    id: "user_2",
    email: "invited@example.com",
  });

  assert.equal(created.status, "active");
  assert.equal(invited.status, "invited");
  assert.equal(invited.must_reset_password, true);
  assert.equal(state.transactions, 2);
});

test("user service activate/disable/lock/updateProfile flows are explicit", async () => {
  const { database, state } = createFakeDatabase();
  const service = createUserService({ database });

  state.users.push({
    id: "user_1",
    email: "user@example.com",
    display_name: "User",
    status: "invited",
    must_reset_password: false,
    is_protected: false,
    deleted_at: null,
    deleted_by_user_id: null,
    delete_reason: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  state.sessions.push({
    id: "session_1",
    user_id: "user_1",
    session_token_hash: "hash",
    trusted_device: false,
    expires_at: "2026-02-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  });

  const activated = await service.activateUser("user_1");
  assert.equal(activated.status, "active");

  const updated = await service.updateProfile("user_1", { display_name: "Updated User" });
  assert.equal(updated.display_name, "Updated User");

  const disabled = await service.disableUser("user_1");
  assert.equal(disabled.status, "disabled");
  assert.equal(state.sessions[0].revoked_at, "2026-01-02T00:00:00.000Z");

  state.sessions[0].revoked_at = null;

  const locked = await service.lockUser("user_1");
  assert.equal(locked.status, "locked");
  assert.equal(state.sessions[0].revoked_at, "2026-01-02T00:00:00.000Z");

  const softDeleted = await service.softDeleteUser("user_1", {
    deleted_by_user_id: "admin_1",
    delete_reason: "retention cleanup",
  });
  assert.equal(softDeleted.status, "deleted");
  assert.equal(softDeleted.deleted_by_user_id, "admin_1");

  const restored = await service.restoreUser("user_1", { status: "disabled" });
  assert.equal(restored.status, "disabled");
  assert.equal(restored.deleted_at, null);
});
