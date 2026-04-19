import test from "node:test";
import assert from "node:assert/strict";

import { buildPostgresPoolConfig } from "../../src/db/client/postgres.mjs";
import { DATABASE_ERROR_KIND, classifyDatabaseError } from "../../src/db/errors.mjs";
import { defineTransactionStrategy, withTransaction } from "../../src/db/transactions.mjs";

function createControlledTransactionRecorder() {
  const calls = [];

  const savepointTrx = {
    releaseSavepoint(name) {
      return {
        async execute() {
          calls.push(["releaseSavepoint", name]);
        },
      };
    },
    rollbackToSavepoint(name) {
      return {
        async execute() {
          calls.push(["rollbackToSavepoint", name]);
        },
      };
    },
  };

  const trx = {
    commit() {
      return {
        async execute() {
          calls.push(["commit"]);
        },
      };
    },
    rollback() {
      return {
        async execute() {
          calls.push(["rollback"]);
        },
      };
    },
    savepoint(name) {
      return {
        async execute() {
          calls.push(["savepoint", name]);
          return savepointTrx;
        },
      };
    },
  };

  return { trx, calls };
}

test("classifyDatabaseError identifies authentication failures", () => {
  const kind = classifyDatabaseError({ code: "28P01", message: "password authentication failed" });
  assert.equal(kind, DATABASE_ERROR_KIND.AUTHENTICATION);
});

test("classifyDatabaseError identifies missing relation failures", () => {
  const kind = classifyDatabaseError(new Error('relation "kysely_migration" does not exist'));
  assert.equal(kind, DATABASE_ERROR_KIND.NOT_FOUND);
});

test("buildPostgresPoolConfig keeps DATABASE_URL as the transport source of truth", () => {
  const config = buildPostgresPoolConfig({
    databaseUrl: "postgres://awcms_mini_app:secret@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full",
  });

  assert.deepEqual(config, {
    connectionString: "postgres://awcms_mini_app:secret@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full",
  });
});

test("buildPostgresPoolConfig preserves reviewed interim SSL modes when explicitly configured", () => {
  const config = buildPostgresPoolConfig({
    databaseUrl: "postgres://awcms_mini_app:secret@202.10.45.224:5432/awcms_mini?sslmode=require",
  });

  assert.equal(config.connectionString, "postgres://awcms_mini_app:secret@202.10.45.224:5432/awcms_mini?sslmode=require");
});

test("defineTransactionStrategy validates supported strategies", () => {
  assert.deepEqual(defineTransactionStrategy("reuse"), { nested: "reuse" });
  assert.throws(() => defineTransactionStrategy("invalid"), /Unsupported transaction strategy/);
});

test("withTransaction commits root transaction on success", async () => {
  const { trx, calls } = createControlledTransactionRecorder();
  const db = {
    startTransaction() {
      return {
        async execute() {
          calls.push(["startTransaction"]);
          return trx;
        },
      };
    },
  };

  const result = await withTransaction(db, async (executor) => {
    assert.equal(executor, trx);
    calls.push(["callback"]);
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(calls, [["startTransaction"], ["callback"], ["commit"]]);
});

test("withTransaction rolls back root transaction on failure", async () => {
  const { trx, calls } = createControlledTransactionRecorder();
  const db = {
    startTransaction() {
      return {
        async execute() {
          calls.push(["startTransaction"]);
          return trx;
        },
      };
    },
  };

  await assert.rejects(
    () =>
      withTransaction(db, async () => {
        calls.push(["callback"]);
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.deepEqual(calls, [["startTransaction"], ["callback"], ["rollback"]]);
});

test("withTransaction reuses nested controlled transaction by default", async () => {
  const { trx, calls } = createControlledTransactionRecorder();

  const result = await withTransaction(trx, async (executor) => {
    assert.equal(executor, trx);
    calls.push(["callback"]);
    return "nested";
  });

  assert.equal(result, "nested");
  assert.deepEqual(calls, [["callback"]]);
});

test("withTransaction supports nested savepoint strategy", async () => {
  const { trx, calls } = createControlledTransactionRecorder();

  const result = await withTransaction(
    trx,
    async (executor) => {
      calls.push(["callback", executor !== trx]);
      return "savepoint";
    },
    { nested: "savepoint", savepointName: "unit_test" },
  );

  assert.equal(result, "savepoint");
  assert.deepEqual(calls, [
    ["savepoint", "unit_test"],
    ["callback", true],
    ["releaseSavepoint", "unit_test"],
  ]);
});
