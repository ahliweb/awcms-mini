import test from "node:test";
import assert from "node:assert/strict";

import { verifyPassword } from "../../src/auth/passwords.mjs";
import { createPasswordResetService, PasswordResetError } from "../../src/services/security/password-reset.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    password_reset_tokens: [],
    sessions: [],
    audit_logs: [],
    security_events: [],
    transactions: 0,
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

    startTransaction() {
      return {
        execute: async () => {
          state.transactions += 1;
          return {
            ...executor,
            commit() { return { execute: async () => {} }; },
            rollback() { return { execute: async () => {} }; },
            savepoint() { return { execute: async () => ({ ...executor, releaseSavepoint() { return { execute: async () => {} }; }, rollbackToSavepoint() { return { execute: async () => {} }; } }) }; },
          };
        },
      };
    },
  };

  return { database: executor, state };
}

test("password reset service issues expiring single-use tokens and consumes them", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null, must_reset_password: true, password_hash: "old_hash" });
  state.sessions.push({ id: "session_1", user_id: "user_1", revoked_at: null, created_at: "2026-01-01T00:00:00.000Z" });

  const service = createPasswordResetService({ database, now: () => "2026-01-05T00:00:00.000Z" });
  const issued = await service.requestPasswordReset({ email: "user@example.com", ttlMs: 1000 * 60 * 10 });

  assert.equal(Boolean(issued.token), true);
  assert.equal(state.password_reset_tokens.length, 1);

  const consumed = await service.consumePasswordReset({ token: issued.token, password: "new-password-123" });
  assert.equal(consumed.must_reset_password, false);
  assert.equal(verifyPassword("new-password-123", state.users[0].password_hash), true);
  assert.equal(state.password_reset_tokens[0].used_at, "2026-01-05T00:00:00.000Z");
  assert.equal(state.sessions[0].revoked_at, "2026-01-05T00:00:00.000Z");
  assert.equal(state.audit_logs.some((entry) => entry.action === "password_reset.consume"), true);
  assert.equal(state.security_events.some((entry) => entry.event_type === "password_reset.consume"), true);

  await assert.rejects(
    () => service.consumePasswordReset({ token: issued.token, password: "new-password-456" }),
    (error) => error instanceof PasswordResetError && error.code === "INVALID_TOKEN",
  );
});

test("password reset service rejects expired tokens and force-reset marks user for reset", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null, must_reset_password: false, password_hash: "old_hash" });
  state.sessions.push({ id: "session_1", user_id: "user_1", revoked_at: null, created_at: "2026-01-01T00:00:00.000Z" });

  const service = createPasswordResetService({ database, now: () => "2026-01-05T00:00:00.000Z" });
  const forced = await service.forcePasswordReset("user_1", { issued_by_user_id: "admin_1", ttlMs: 1000 * 60 * 10 });
  assert.equal(state.users[0].must_reset_password, true);
  assert.equal(state.sessions[0].revoked_at, "2026-01-05T00:00:00.000Z");
  assert.equal(Boolean(forced.token), true);
  assert.equal(state.audit_logs.some((entry) => entry.action === "password_reset.force_require"), true);
  assert.equal(state.security_events.some((entry) => entry.event_type === "password_reset.force_issue"), true);
  assert.equal(state.security_events.some((entry) => entry.event_type === "password_reset.force_require"), true);

  state.password_reset_tokens[0].expires_at = "2026-01-01T00:00:00.000Z";
  await assert.rejects(
    () => service.consumePasswordReset({ token: forced.token, password: "new-password-123" }),
    (error) => error instanceof PasswordResetError && error.code === "EXPIRED_TOKEN",
  );
});
