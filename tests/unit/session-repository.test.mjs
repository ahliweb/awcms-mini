import test from "node:test";
import assert from "node:assert/strict";

import { createSessionRepository } from "../../src/db/repositories/sessions.mjs";

class FakeSessionExecutor {
  constructor() {
    this.sessions = [];
  }

  insertInto(table) {
    assert.equal(table, "sessions");

    return {
      values: (values) => ({
        execute: async () => {
          this.sessions.push({
            created_at: values.created_at ?? "2026-01-01T00:00:00.000Z",
            ...values,
          });
        },
      }),
    };
  }

  selectFrom(table) {
    assert.equal(table, "sessions");

    const state = {
      where: [],
      limit: undefined,
      offset: undefined,
    };

    const apply = () => {
      let rows = [...this.sessions];

      for (const clause of state.where) {
        if (clause.operator === "=") {
          rows = rows.filter((row) => row[clause.column] === clause.value);
        } else if (clause.operator === "is") {
          rows = rows.filter((row) => row[clause.column] === clause.value);
        }
      }

      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));

      if (state.offset !== undefined) {
        rows = rows.slice(state.offset);
      }

      if (state.limit !== undefined) {
        rows = rows.slice(0, state.limit);
      }

      return rows;
    };

    const query = {
      select: () => query,
      where: (column, operator, value) => {
        state.where.push({ column, operator, value });
        return query;
      },
      orderBy: () => query,
      limit: (limit) => {
        state.limit = limit;
        return query;
      },
      offset: (offset) => {
        state.offset = offset;
        return query;
      },
      execute: async () => apply(),
      executeTakeFirst: async () => apply()[0],
    };

    return query;
  }

  updateTable(table) {
    assert.equal(table, "sessions");

    const state = {
      values: undefined,
      where: [],
    };

    return {
      set: (values) => {
        state.values = values;

        const chain = {
          where: (column, operator, value) => {
            state.where.push({ column, operator, value });
            return chain;
          },
          execute: async () => {
            for (const row of this.sessions) {
              const matches = state.where.every((clause) => {
                if (clause.operator === "=") {
                  return row[clause.column] === clause.value;
                }

                if (clause.operator === "is") {
                  return row[clause.column] === clause.value;
                }

                return false;
              });

              if (!matches) {
                continue;
              }

              for (const [key, nextValue] of Object.entries(state.values)) {
                row[key] = typeof nextValue === "object" ? "2026-01-02T00:00:00.000Z" : nextValue;
              }
            }
          },
        };

        return chain;
      },
    };
  }
}

test("session repository supports create/get/list/update/revoke flows", async () => {
  const executor = new FakeSessionExecutor();
  const repo = createSessionRepository(executor);

  const created = await repo.createSession({
    id: "session_1",
    user_id: "user_1",
    session_token_hash: "hash_1",
    trusted_device: true,
    expires_at: "2026-02-01T00:00:00.000Z",
  });

  assert.equal(created.id, "session_1");
  assert.equal(created.session_token_hash, "hash_1");
  assert.equal(created.trusted_device, true);
  assert.equal(created.revoked_at, null);

  const byToken = await repo.getSessionByTokenHash("hash_1");
  assert.equal(byToken.id, "session_1");

  const updated = await repo.updateSessionLastSeen("session_1", "2026-01-15T00:00:00.000Z");
  assert.equal(updated.last_seen_at, "2026-01-15T00:00:00.000Z");

  const revoked = await repo.revokeSession("session_1", "2026-01-16T00:00:00.000Z");
  assert.equal(revoked.revoked_at, "2026-01-16T00:00:00.000Z");
});

test("session repository supports list and revoke-all by user", async () => {
  const executor = new FakeSessionExecutor();
  const repo = createSessionRepository(executor);

  await repo.createSession({
    id: "session_1",
    user_id: "user_1",
    session_token_hash: "hash_1",
    expires_at: "2026-02-01T00:00:00.000Z",
  });

  await repo.createSession({
    id: "session_2",
    user_id: "user_1",
    session_token_hash: "hash_2",
    expires_at: "2026-02-01T00:00:00.000Z",
  });

  await repo.createSession({
    id: "session_3",
    user_id: "user_2",
    session_token_hash: "hash_3",
    expires_at: "2026-02-01T00:00:00.000Z",
  });

  const userSessions = await repo.listSessionsByUserId("user_1");
  assert.equal(userSessions.length, 2);

  const revoked = await repo.revokeAllSessionsForUser("user_1", "2026-01-20T00:00:00.000Z");
  assert.equal(revoked.filter((session) => session.user_id === "user_1").every((session) => session.revoked_at === "2026-01-20T00:00:00.000Z"), true);

  const activeSessions = await repo.listSessionsByUserId("user_1");
  assert.equal(activeSessions.length, 0);

  const allSessions = await repo.listSessionsByUserId("user_1", { includeRevoked: true });
  assert.equal(allSessions.length, 2);
});
