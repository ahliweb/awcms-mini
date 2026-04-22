import test from "node:test";
import assert from "node:assert/strict";

import { EMDASH_MINI_COMPATIBILITY_MIGRATIONS } from "../../src/db/migrations/emdash-compatibility.mjs";
import { getEmdashMigrationStatus, repairEmdashMigrationLedger, verifyEmdashMigrationStatus } from "../../src/db/migrations/runner.mjs";

function createLedgerDbStub({ rows = [], throwMissingTable = false } = {}) {
  const state = {
    rows: [...rows],
    deleted: false,
    inserted: [],
  };

  const db = {
    selectFrom(table) {
      assert.equal(table, "_emdash_migrations");

      return {
        select(columns) {
          assert.deepEqual(columns, ["name", "timestamp"]);

          return {
            async execute() {
              if (throwMissingTable) {
                throw new Error('relation "_emdash_migrations" does not exist');
              }

              return [...state.rows];
            },
          };
        },
      };
    },

    transaction() {
      return {
        async execute(callback) {
          return callback({
            deleteFrom(table) {
              assert.equal(table, "_emdash_migrations");

              return {
                async execute() {
                  state.deleted = true;
                  state.rows = [];
                },
              };
            },

            insertInto(table) {
              assert.equal(table, "_emdash_migrations");

              return {
                values(values) {
                  return {
                    async execute() {
                      state.inserted = [...values];
                      state.rows = [...values];
                    },
                  };
                },
              };
            },
          });
        },
      };
    },
  };

  return { db, state };
}

test("getEmdashMigrationStatus treats a missing EmDash ledger table as empty", async () => {
  const { db } = createLedgerDbStub({ throwMissingTable: true });

  const status = await getEmdashMigrationStatus(db);

  assert.deepEqual(status.applied, []);
  assert.equal(status.repair.state, "empty");
});

test("getEmdashMigrationStatus reports repairable out-of-order canonical ledgers", async () => {
  const { db } = createLedgerDbStub({
    rows: [
      { name: "001_initial", timestamp: "2026-02-03T10:00:00.000Z" },
      { name: "003_schema_registry", timestamp: "2026-02-03T10:01:00.000Z" },
      { name: "002_media_status", timestamp: "2026-02-03T10:02:00.000Z" },
    ],
  });

  const status = await getEmdashMigrationStatus(db);

  assert.deepEqual(status.applied, ["001_initial", "003_schema_registry", "002_media_status"]);
  assert.equal(status.repair.state, "repairable");
  assert.deepEqual(status.pending, EMDASH_MINI_COMPATIBILITY_MIGRATIONS.slice(3));
});

test("verifyEmdashMigrationStatus accepts compatible ledgers", async () => {
  const { db } = createLedgerDbStub({
    rows: EMDASH_MINI_COMPATIBILITY_MIGRATIONS.slice(0, 3).map((name, index) => ({
      name,
      timestamp: new Date(Date.UTC(2026, 1, 3, 10, index, 0)).toISOString(),
    })),
  });

  const status = await getEmdashMigrationStatus(db);

  assert.equal(verifyEmdashMigrationStatus(status), status);
});

test("verifyEmdashMigrationStatus rejects non-compatible ledgers", async () => {
  const { db } = createLedgerDbStub({ throwMissingTable: true });
  const status = await getEmdashMigrationStatus(db);

  assert.throws(
    () => verifyEmdashMigrationStatus(status),
    /Expected EmDash compatibility state=compatible but found empty/,
  );
});

test("repairEmdashMigrationLedger rewrites repairable ledgers into canonical prefix order", async () => {
  const { db, state } = createLedgerDbStub({
    rows: [
      { name: "001_initial", timestamp: "2026-02-03T10:00:00.000Z" },
      { name: "003_schema_registry", timestamp: "2026-02-03T10:01:00.000Z" },
      { name: "002_media_status", timestamp: "2026-02-03T10:02:00.000Z" },
    ],
  });

  const outcome = await repairEmdashMigrationLedger(db);

  assert.equal(outcome.changed, true);
  assert.equal(state.deleted, true);
  assert.deepEqual(
    state.inserted.map((entry) => entry.name),
    ["001_initial", "002_media_status", "003_schema_registry"],
  );
  assert.equal(state.inserted[0]?.timestamp, "2026-02-03T10:00:00.000Z");
  assert.equal(state.inserted[1]?.timestamp, "2026-02-03T10:01:00.000Z");
});

test("repairEmdashMigrationLedger refuses unsafe ledgers", async () => {
  const { db, state } = createLedgerDbStub({
    rows: [
      { name: "001_initial", timestamp: "2026-02-03T10:00:00.000Z" },
      { name: "026_cron_tasks", timestamp: "2026-02-03T10:01:00.000Z" },
    ],
  });

  const outcome = await repairEmdashMigrationLedger(db);

  assert.equal(outcome.changed, false);
  assert.equal(outcome.repair.state, "unsafe");
  assert.equal(state.deleted, false);
  assert.deepEqual(state.inserted, []);
});
