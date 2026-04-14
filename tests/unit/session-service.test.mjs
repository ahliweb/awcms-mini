import test from "node:test";
import assert from "node:assert/strict";

import { createSessionService } from "../../src/services/sessions/service.mjs";

function createFakeDatabase() {
  const state = {
    sessions: [],
    transactions: 0,
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
          },
        }),
      };
    },

    selectFrom(table) {
      const local = {
        where: [],
        limit: undefined,
        offset: undefined,
      };

      const query = {
        select: () => query,
        where: (column, operator, value) => {
          local.where.push({ column, operator, value });
          return query;
        },
        orderBy: () => query,
        limit: (limit) => {
          local.limit = limit;
          return query;
        },
        offset: (offset) => {
          local.offset = offset;
          return query;
        },
        execute: async () => {
          let rows = [...state.sessions];

          for (const clause of local.where) {
            if (clause.operator === "=" || clause.operator === "is") {
              rows = rows.filter((row) => row[clause.column] === clause.value);
            }
          }

          rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));

          if (local.offset !== undefined) rows = rows.slice(local.offset);
          if (local.limit !== undefined) rows = rows.slice(0, local.limit);

          return rows;
        },
        executeTakeFirst: async () => {
          const rows = await query.execute();
          return rows[0];
        },
      };

      return query;
    },

    updateTable(table) {
      const stateful = { values: undefined, where: [] };

      return {
        set: (values) => {
          stateful.values = values;

          const chain = {
            where: (column, operator, value) => {
              stateful.where.push({ column, operator, value });
              return chain;
            },
            execute: async () => {
              for (const row of state.sessions) {
                const matches = stateful.where.every((clause) => row[clause.column] === clause.value);
                if (!matches) continue;

                for (const [key, nextValue] of Object.entries(stateful.values)) {
                  row[key] = typeof nextValue === "object" ? "2026-01-02T00:00:00.000Z" : nextValue;
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

test("session service issues and refreshes sessions with trusted-device flag", async () => {
  const { database, state } = createFakeDatabase();
  const service = createSessionService({ database });

  const issued = await service.issueSession({
    id: "session_1",
    user_id: "user_1",
    session_token_hash: "hash_1",
    trusted_device: true,
    expires_at: "2026-02-01T00:00:00.000Z",
  });

  assert.equal(issued.id, "session_1");
  assert.equal(issued.trusted_device, true);

  const refreshed = await service.refreshSession("session_1", "2026-01-15T00:00:00.000Z");
  assert.equal(refreshed.last_seen_at, "2026-01-15T00:00:00.000Z");
  assert.equal(state.transactions, 2);
});

test("session service supports revoke, revoke-all, and list-active", async () => {
  const { database, state } = createFakeDatabase();
  const service = createSessionService({ database });

  state.sessions.push(
    {
      id: "session_1",
      user_id: "user_1",
      session_token_hash: "hash_1",
      trusted_device: false,
      expires_at: "2026-02-01T00:00:00.000Z",
      revoked_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "session_2",
      user_id: "user_1",
      session_token_hash: "hash_2",
      trusted_device: true,
      expires_at: "2026-02-01T00:00:00.000Z",
      revoked_at: null,
      created_at: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "session_3",
      user_id: "user_2",
      session_token_hash: "hash_3",
      trusted_device: false,
      expires_at: "2026-02-01T00:00:00.000Z",
      revoked_at: null,
      created_at: "2026-01-03T00:00:00.000Z",
    },
  );

  const revoked = await service.revokeSession("session_1", "2026-01-20T00:00:00.000Z");
  assert.equal(revoked.revoked_at, "2026-01-20T00:00:00.000Z");

  const activeBeforeAll = await service.listActiveSessions("user_1");
  assert.equal(activeBeforeAll.length, 1);
  assert.equal(activeBeforeAll[0].id, "session_2");

  const revokedAll = await service.revokeAllSessionsForUser("user_1", "2026-01-21T00:00:00.000Z");
  assert.equal(revokedAll.filter((session) => session.user_id === "user_1").every((session) => session.revoked_at !== null), true);

  const activeAfterAll = await service.listActiveSessions("user_1");
  assert.equal(activeAfterAll.length, 0);
});
