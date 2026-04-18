import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/031_soft_delete_operator_attribution_catalogs.mjs";

function createFakeSchemaRecorder() {
  const operations = [];

  function alterTableBuilder(table) {
    return {
      addColumn(name, type, callback) {
        operations.push(["addColumn", table, name, type]);
        if (callback) {
          const column = {
            references(reference) {
              operations.push(["references", table, name, reference]);
              return column;
            },
            onDelete(value) {
              operations.push(["onDelete", table, name, value]);
              return column;
            },
          };
          callback(column);
        }
        return this;
      },
      dropColumn(name) {
        operations.push(["dropColumn", table, name]);
        return this;
      },
      execute: async () => {
        operations.push(["alterTableExecute", table]);
      },
    };
  }

  return {
    operations,
    db: {
      schema: {
        alterTable(table) {
          operations.push(["alterTable", table]);
          return alterTableBuilder(table);
        },
      },
    },
  };
}

test("soft delete attribution migration adds operator attribution columns to mutable catalogs", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "job_levels" && entry[2] === "deleted_by_user_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "job_titles" && entry[2] === "delete_reason"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "regions" && entry[2] === "deleted_by_user_id"));
});

test("soft delete attribution migration down removes operator attribution columns", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => entry[0] === "dropColumn"),
    [
      ["dropColumn", "regions", "delete_reason"],
      ["dropColumn", "regions", "deleted_by_user_id"],
      ["dropColumn", "job_titles", "delete_reason"],
      ["dropColumn", "job_titles", "deleted_by_user_id"],
      ["dropColumn", "job_levels", "delete_reason"],
      ["dropColumn", "job_levels", "deleted_by_user_id"],
    ],
  );
});
