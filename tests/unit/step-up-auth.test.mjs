import test from "node:test";
import assert from "node:assert/strict";

import { handleAuthTwoFactorStepUpVerify } from "../../src/auth/handlers/two-factor-step-up.mjs";
import { hashPassword } from "../../src/auth/passwords.mjs";
import { requireFreshTwoFactor } from "../../src/auth/step-up.mjs";
import { createTwoFactorService } from "../../src/services/security/two-factor.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    totp_credentials: [],
    recovery_codes: [],
    security_events: [],
    audit_logs: [],
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
                verified_at: item.verified_at ?? null,
                last_used_at: item.last_used_at ?? null,
                disabled_at: item.disabled_at ?? null,
                used_at: item.used_at ?? null,
                replaced_at: item.replaced_at ?? null,
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
      const stateful = { where: [], orderBy: [] };
      const apply = () => {
        let rows = [...source];
        for (const clause of stateful.where) {
          if (clause.operator === "=" || clause.operator === "is") rows = rows.filter((row) => row[clause.column] === clause.value);
        }
        rows.sort((a, b) => {
          for (const clause of stateful.orderBy) {
            const cmp = String(a[clause.column] ?? "").localeCompare(String(b[clause.column] ?? ""));
            if (cmp) return clause.direction === "desc" ? -cmp : cmp;
          }
          return 0;
        });
        return rows;
      };
      const query = {
        select: () => query,
        where: (column, operator, value) => { stateful.where.push({ column, operator, value }); return query; },
        orderBy: (column, direction = "asc") => { stateful.orderBy.push({ column, direction }); return query; },
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
                const matches = local.where.every((clause) => row[clause.column] === clause.value);
                if (!matches) continue;
                Object.assign(row, Object.fromEntries(Object.entries(local.values).map(([k, v]) => [k, typeof v === "object" && v !== null ? "2026-01-02T00:00:00.000Z" : v])));
              }
            },
          };
          return chain;
        },
      };
    },
    startTransaction() {
      return { execute: async () => ({ ...executor, commit() { return { execute: async () => {} }; }, rollback() { return { execute: async () => {} }; }, savepoint() { return { execute: async () => ({ ...executor, releaseSavepoint() { return { execute: async () => {} }; }, rollbackToSavepoint() { return { execute: async () => {} }; } }) }; } }) };
    },
  };
  return { database: executor, state };
}

function createFakeSession() {
  const values = new Map();
  return {
    set(key, value) { values.set(key, value); },
    get(key) { return values.get(key); },
    destroy() { values.clear(); },
  };
}

test("requireFreshTwoFactor rejects missing or stale step-up state and accepts fresh state", async () => {
  const session = createFakeSession();

  let result = await requireFreshTwoFactor({ session, now: Date.parse("2026-01-05T00:10:00.000Z") });
  assert.equal(result.ok, false);

  session.set("identitySession", { id: "session_1", twoFactorSatisfied: true, stepUpAuthenticated: true, stepUpAt: "2026-01-05T00:00:00.000Z" });
  result = await requireFreshTwoFactor({ session, maxAgeMs: 5 * 60 * 1000, now: Date.parse("2026-01-05T00:10:01.000Z") });
  assert.equal(result.ok, false);

  session.set("identitySession", { id: "session_1", twoFactorSatisfied: true, stepUpAuthenticated: true, stepUpAt: "2026-01-05T00:08:00.000Z" });
  result = await requireFreshTwoFactor({ session, maxAgeMs: 5 * 60 * 1000, now: Date.parse("2026-01-05T00:10:01.000Z") });
  assert.equal(result.ok, true);
});

test("step-up verify upgrades session to step_up strength", async () => {
  const { database, state } = createFakeDatabase();
  const session = createFakeSession();
  const previousEncryptionKey = process.env.MINI_TOTP_ENCRYPTION_KEY;
  process.env.MINI_TOTP_ENCRYPTION_KEY = "12345678901234567890123456789012";
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null, password_hash: hashPassword("very-secure-password") });

  try {
    const twoFactor = createTwoFactorService({ database, encryptionKey: "12345678901234567890123456789012", now: () => "2026-01-05T00:00:00.000Z" });
    const enrollment = await twoFactor.beginEnrollment({ user_id: "user_1" });
    const code = twoFactor.generateCurrentCodeForTesting(enrollment.manualKey, { timestamp: Date.parse("2026-01-05T00:00:00.000Z") });
    await twoFactor.verifyEnrollment({ user_id: "user_1", code, timestamp: Date.parse("2026-01-05T00:00:00.000Z") });

    session.set("user", { id: "user_1" });
    session.set("identitySession", { id: "session_1", sessionStrength: "two_factor", twoFactorSatisfied: true, stepUpAuthenticated: false });

    const stepUpCode = twoFactor.generateCurrentCodeForTesting(enrollment.manualKey);
    const response = await handleAuthTwoFactorStepUpVerify({
      request: new Request("http://example.test/_emdash/api/auth/2fa/step-up/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: stepUpCode }),
      }),
      session,
      db: database,
      now: () => "2026-01-05T00:09:00.000Z",
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.session.sessionStrength, "step_up");
    assert.equal(body.session.stepUpAuthenticated, true);
    assert.equal(session.get("identitySession").stepUpAt, "2026-01-05T00:09:00.000Z");
  } finally {
    process.env.MINI_TOTP_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test("step-up verify logs audit and security events on failure", async () => {
  const { database, state } = createFakeDatabase();
  const session = createFakeSession();
  const previousEncryptionKey = process.env.MINI_TOTP_ENCRYPTION_KEY;
  process.env.MINI_TOTP_ENCRYPTION_KEY = "12345678901234567890123456789012";
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null, password_hash: hashPassword("very-secure-password") });

  try {
    const twoFactor = createTwoFactorService({ database, encryptionKey: "12345678901234567890123456789012", now: () => "2026-01-05T00:00:00.000Z" });
    const enrollment = await twoFactor.beginEnrollment({ user_id: "user_1" });
    const code = twoFactor.generateCurrentCodeForTesting(enrollment.manualKey, { timestamp: Date.parse("2026-01-05T00:00:00.000Z") });
    await twoFactor.verifyEnrollment({ user_id: "user_1", code, timestamp: Date.parse("2026-01-05T00:00:00.000Z") });

    session.set("user", { id: "user_1" });
    session.set("identitySession", { id: "session_1", sessionStrength: "two_factor", twoFactorSatisfied: true, stepUpAuthenticated: false });

    const response = await handleAuthTwoFactorStepUpVerify({
      request: new Request("http://example.test/_emdash/api/auth/2fa/step-up/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "user-agent": "unit-test", "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ code: "000000" }),
      }),
      session,
      db: database,
      now: () => "2026-01-05T00:09:00.000Z",
    });

    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "TOTP_CODE_INVALID");
    assert.equal(state.audit_logs.some((entry) => entry.action === "auth.step_up.failure"), true);
    assert.equal(state.security_events.some((entry) => entry.event_type === "auth.step_up.failure"), true);
  } finally {
    process.env.MINI_TOTP_ENCRYPTION_KEY = previousEncryptionKey;
  }
});
