import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PERMISSION_GROUPS,
  DEFAULT_PERMISSIONS,
  down,
  up,
} from "../../src/db/migrations/014_default_permissions.mjs";

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

test("default permission seed groups entries by domain and marks protected permissions explicitly", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await up(db);

  assert.deepEqual(Object.keys(DEFAULT_PERMISSION_GROUPS), ["admin", "audit", "content", "governance", "plugins", "security"]);
  assert.ok(DEFAULT_PERMISSIONS.length >= 20);
  assert.ok(DEFAULT_PERMISSIONS.some((permission) => permission.code === "admin.roles.assign" && permission.is_protected === true));
  assert.ok(DEFAULT_PERMISSIONS.some((permission) => permission.code === "security.2fa.reset" && permission.is_protected === true));
  assert.ok(DEFAULT_PERMISSIONS.some((permission) => permission.code === "content.posts.publish" && permission.is_protected === false));

  const insertedValues = operations.find((entry) => entry[0] === "values")?.[1] ?? [];
  assert.equal(insertedValues.length, DEFAULT_PERMISSIONS.length);
  assert.ok(insertedValues.every((permission) => permission.domain && permission.resource && permission.action));
});

test("default permission seed down removes the seeded permission ids", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await down(db);

  assert.deepEqual(operations.filter((entry) => ["deleteFrom", "where"].includes(entry[0])), [
    ["deleteFrom", "permissions"],
    ["where", "permissions", "id", "in", DEFAULT_PERMISSIONS.map((permission) => permission.id)],
  ]);
});
