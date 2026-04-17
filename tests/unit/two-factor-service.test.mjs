import test from "node:test";
import assert from "node:assert/strict";

import {
  createTwoFactorService,
  TwoFactorChallengeError,
  TwoFactorEnrollmentError,
} from "../../src/services/security/two-factor.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    totp_credentials: [],
    recovery_codes: [],
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

test("two-factor service creates pending enrollment and verifies it before enablement", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null });
  const service = createTwoFactorService({ database, encryptionKey: "12345678901234567890123456789012", now: () => "2026-01-05T00:00:00.000Z" });

  const enrollment = await service.beginEnrollment({ user_id: "user_1" });
  assert.equal(Boolean(enrollment.manualKey), true);
  assert.equal(state.totp_credentials.length, 1);
  assert.equal(state.totp_credentials[0].verified_at, null);

  const code = service.generateCurrentCodeForTesting(enrollment.manualKey, { timestamp: Date.parse("2026-01-05T00:00:00.000Z") });
  const verified = await service.verifyEnrollment({ user_id: "user_1", code, timestamp: Date.parse("2026-01-05T00:00:00.000Z") });
  assert.equal(verified.credential.verified_at, "2026-01-05T00:00:00.000Z");
  assert.equal(verified.recoveryCodes.length, 8);
  assert.equal(state.recovery_codes.length, 8);

  const status = await service.getEnrollmentStatus("user_1");
  assert.equal(status.enrolled, true);
  assert.equal(status.pending, false);
  assert.equal(status.recoveryCodeCount, 8);
});

test("two-factor service rejects verification when no enrollment exists or the code is wrong", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null });
  const service = createTwoFactorService({ database, encryptionKey: "12345678901234567890123456789012" });

  await assert.rejects(
    () => service.verifyEnrollment({ user_id: "user_1", code: "123456" }),
    (error) => error instanceof TwoFactorEnrollmentError && error.code === "TOTP_ENROLLMENT_NOT_FOUND",
  );

  await service.beginEnrollment({ user_id: "user_1" });

  await assert.rejects(
    () => service.verifyEnrollment({ user_id: "user_1", code: "000000", timestamp: Date.now() }),
    (error) => error instanceof TwoFactorEnrollmentError && error.code === "TOTP_CODE_INVALID",
  );
});

test("two-factor service allows one-time recovery code fallback and rejects reuse", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null });
  const service = createTwoFactorService({ database, encryptionKey: "12345678901234567890123456789012", now: () => "2026-01-05T00:00:00.000Z" });

  const enrollment = await service.beginEnrollment({ user_id: "user_1" });
  const code = service.generateCurrentCodeForTesting(enrollment.manualKey, { timestamp: Date.parse("2026-01-05T00:00:00.000Z") });
  const verified = await service.verifyEnrollment({ user_id: "user_1", code, timestamp: Date.parse("2026-01-05T00:00:00.000Z") });

  const recoveryCode = verified.recoveryCodes[0];
  const result = await service.verifyRecoveryCodeChallenge({ user_id: "user_1", code: recoveryCode });
  assert.equal(result.usedAt, "2026-01-05T00:00:00.000Z");
  assert.equal(state.recovery_codes.filter((entry) => entry.used_at === "2026-01-05T00:00:00.000Z").length, 1);

  await assert.rejects(
    () => service.verifyRecoveryCodeChallenge({ user_id: "user_1", code: recoveryCode }),
    (error) => error instanceof TwoFactorChallengeError && error.code === "RECOVERY_CODE_INVALID",
  );
});

test("two-factor service regenerates recovery codes and invalidates the prior set", async () => {
  const { database, state } = createFakeDatabase();
  state.users.push({ id: "user_1", email: "user@example.com", status: "active", deleted_at: null });
  const service = createTwoFactorService({ database, encryptionKey: "12345678901234567890123456789012", now: () => "2026-01-05T00:00:00.000Z" });

  const enrollment = await service.beginEnrollment({ user_id: "user_1" });
  const code = service.generateCurrentCodeForTesting(enrollment.manualKey, { timestamp: Date.parse("2026-01-05T00:00:00.000Z") });
  const verified = await service.verifyEnrollment({ user_id: "user_1", code, timestamp: Date.parse("2026-01-05T00:00:00.000Z") });
  const firstCode = verified.recoveryCodes[0];

  const regenerated = await service.regenerateRecoveryCodes({ user_id: "user_1" });
  assert.equal(regenerated.recoveryCodes.length, 8);
  assert.equal(state.recovery_codes.filter((entry) => entry.replaced_at === "2026-01-05T00:00:00.000Z").length, 8);

  await assert.rejects(
    () => service.verifyRecoveryCodeChallenge({ user_id: "user_1", code: firstCode }),
    (error) => error instanceof TwoFactorChallengeError && error.code === "RECOVERY_CODE_INVALID",
  );
});
