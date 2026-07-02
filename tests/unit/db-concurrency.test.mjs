import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireAdvisoryXactLock,
  buildAdvisoryLockKey,
  isSerializationFailure,
  SQLSTATE_DEADLOCK_DETECTED,
  SQLSTATE_SERIALIZATION_FAILURE,
  withAdvisoryXactLock,
  withSerializableRetry,
} from "../../src/db/concurrency.mjs";

// Fake Kysely-like database + controlled transaction.
// Cukup untuk menguji orkestrasi withSerializableRetry (begin/isolation/commit/rollback)
// tanpa PostgreSQL nyata. Meniru bentuk API Kysely: startTransaction() →
// .setIsolationLevel() → .execute() menghasilkan controlled transaction yang
// commit()/rollback()-nya mengembalikan builder ber-.execute().
function createFakeDatabase() {
  const events = [];
  const db = {
    events,
    attempts: 0,
    startTransaction() {
      let level;
      return {
        setIsolationLevel(isolationLevel) {
          level = isolationLevel;
          return this;
        },
        async execute() {
          db.attempts += 1;
          const attempt = db.attempts;
          events.push({ type: "isolation", level });
          events.push({ type: "begin", attempt });
          return {
            commit() {
              return { execute: async () => events.push({ type: "commit", attempt }) };
            },
            rollback() {
              return { execute: async () => events.push({ type: "rollback", attempt }) };
            },
          };
        },
      };
    },
  };
  return db;
}

test("isSerializationFailure: mendeteksi SQLSTATE 40001 dan 40P01", () => {
  assert.equal(isSerializationFailure({ code: SQLSTATE_SERIALIZATION_FAILURE }), true);
  assert.equal(isSerializationFailure({ code: SQLSTATE_DEADLOCK_DETECTED }), true);
  assert.equal(isSerializationFailure({ code: "23505" }), false, "unique violation bukan transient");
  assert.equal(isSerializationFailure(new Error("boom")), false);
  assert.equal(isSerializationFailure(null), false);
});

test("isSerializationFailure: menelusuri error.cause.code (error terbungkus)", () => {
  const wrapped = new Error("wrapped");
  wrapped.cause = { code: SQLSTATE_SERIALIZATION_FAILURE };
  assert.equal(isSerializationFailure(wrapped), true);
});

test("buildAdvisoryLockKey: menggabungkan namespace dan id", () => {
  assert.equal(buildAdvisoryLockKey("awcms-mini:numbering", "2026:invoice"), "awcms-mini:numbering:2026:invoice");
});

test("buildAdvisoryLockKey: menolak namespace/id kosong", () => {
  assert.throws(() => buildAdvisoryLockKey("", "x"), /non-empty namespace/);
  assert.throws(() => buildAdvisoryLockKey("ns", ""), /non-empty id/);
  assert.throws(() => buildAdvisoryLockKey("ns", null), /non-empty id/);
});

test("acquireAdvisoryXactLock: menolak eksekutor non-transaksi", async () => {
  await assert.rejects(() => acquireAdvisoryXactLock({}, "k"), /active transaction/);
});

test("acquireAdvisoryXactLock: menolak key kosong", async () => {
  const fakeTrx = { commit() {}, rollback() {} };
  await assert.rejects(() => acquireAdvisoryXactLock(fakeTrx, ""), /non-empty key/);
});

test("withAdvisoryXactLock: guard menolak eksekutor non-transaksi sebelum menyentuh SQL", async () => {
  // Guard berjalan sebelum kompilasi SQL apa pun, jadi eksekutor tanpa
  // commit/rollback ditolak deterministik tanpa DB nyata.
  let callbackRan = false;
  await assert.rejects(
    () => withAdvisoryXactLock({}, "awcms-mini:domain:acme", async () => {
      callbackRan = true;
    }),
    /active transaction/,
  );
  assert.equal(callbackRan, false, "callback tidak boleh berjalan bila lock gagal diambil");
});

test("withSerializableRetry: commit sekali saat callback sukses", async () => {
  const db = createFakeDatabase();
  const result = await withSerializableRetry(db, async () => "ok");
  assert.equal(result, "ok");
  assert.equal(db.attempts, 1);
  const types = db.events.map((e) => e.type);
  assert.deepEqual(types, ["isolation", "begin", "commit"]);
  assert.equal(db.events[0].level, "serializable");
});

test("withSerializableRetry: retry pada serialization failure lalu sukses", async () => {
  const db = createFakeDatabase();
  const retries = [];
  let calls = 0;

  const result = await withSerializableRetry(
    db,
    async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error("conflict");
        err.code = SQLSTATE_SERIALIZATION_FAILURE;
        throw err;
      }
      return "done";
    },
    { onRetry: (info) => retries.push(info.attempt) },
  );

  assert.equal(result, "done");
  assert.equal(calls, 3, "dua kali gagal + satu kali sukses");
  assert.equal(db.attempts, 3);
  assert.deepEqual(retries, [1, 2]);
  const rollbacks = db.events.filter((e) => e.type === "rollback").length;
  const commits = db.events.filter((e) => e.type === "commit").length;
  assert.equal(rollbacks, 2);
  assert.equal(commits, 1);
});

test("withSerializableRetry: berhenti setelah kehabisan retry dan melempar error asli", async () => {
  const db = createFakeDatabase();
  const err = new Error("persistent conflict");
  err.code = SQLSTATE_SERIALIZATION_FAILURE;

  await assert.rejects(
    () => withSerializableRetry(db, async () => Promise.reject(err), { retries: 2 }),
    /persistent conflict/,
  );
  // 1 percobaan awal + 2 retry = 3 transaksi.
  assert.equal(db.attempts, 3);
  assert.equal(db.events.filter((e) => e.type === "rollback").length, 3);
  assert.equal(db.events.filter((e) => e.type === "commit").length, 0);
});

test("withSerializableRetry: error non-transient langsung dilempar tanpa retry", async () => {
  const db = createFakeDatabase();
  const err = new Error("unique violation");
  err.code = "23505";

  await assert.rejects(() => withSerializableRetry(db, async () => Promise.reject(err)), /unique violation/);
  assert.equal(db.attempts, 1, "tidak ada retry untuk error non-transient");
  assert.equal(db.events.filter((e) => e.type === "rollback").length, 1);
});

test("withSerializableRetry: menolak eksekutor tanpa startTransaction", async () => {
  await assert.rejects(() => withSerializableRetry({}, async () => null), /Kysely database instance/);
});
