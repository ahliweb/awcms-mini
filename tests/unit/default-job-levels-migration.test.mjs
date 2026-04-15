import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_JOB_LEVELS, down, up } from "../../src/db/migrations/020_default_job_levels.mjs";

function createFakeSeedRecorder() {
  const operations = [];

  return {
    operations,
    db: {
      insertInto(table) {
        operations.push(["insertInto", table]);

        return {
          values(values) {
            operations.push(["values", values]);

            return {
              execute: async () => {
                operations.push(["insertExecute", table]);
              },
            };
          },
        };
      },

      deleteFrom(table) {
        operations.push(["deleteFrom", table]);

        return {
          where(column, operator, value) {
            operations.push(["where", table, column, operator, value]);

            return {
              execute: async () => {
                operations.push(["deleteExecute", table]);
              },
            };
          },
        };
      },
    },
  };
}

test("default job level seed defines a documented ordered ladder", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await up(db);

  assert.equal(DEFAULT_JOB_LEVELS.length, 10);
  assert.deepEqual(
    DEFAULT_JOB_LEVELS.map((level) => [level.code, level.rank_order]),
    [
      ["executive", 10],
      ["director", 9],
      ["head", 8],
      ["manager", 7],
      ["lead", 6],
      ["supervisor", 5],
      ["coordinator", 4],
      ["senior_staff", 3],
      ["staff", 2],
      ["associate", 1],
    ],
  );
  assert.ok(DEFAULT_JOB_LEVELS.every((level) => level.is_system === true));
  assert.ok(DEFAULT_JOB_LEVELS.every((level) => typeof level.description === "string" && level.description.length > 0));

  const insertedValues = operations.find((entry) => entry[0] === "values")?.[1] ?? [];
  assert.equal(insertedValues.length, DEFAULT_JOB_LEVELS.length);
});

test("default job level seed down removes the seeded level ids", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await down(db);

  assert.deepEqual(operations.filter((entry) => ["deleteFrom", "where"].includes(entry[0])), [
    ["deleteFrom", "job_levels"],
    ["where", "job_levels", "id", "in", DEFAULT_JOB_LEVELS.map((level) => level.id)],
  ]);
});
