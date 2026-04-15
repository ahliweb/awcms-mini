import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ROLES, down, up } from "../../src/db/migrations/015_default_roles.mjs";

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

test("default role seed defines the planned role catalog and protected markers", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await up(db);

  assert.equal(DEFAULT_ROLES.length, 11);
  assert.deepEqual(
    DEFAULT_ROLES.map((role) => [role.slug, role.staff_level]),
    [
      ["owner", 10],
      ["super_admin", 9],
      ["admin", 8],
      ["security_admin", 8],
      ["region_manager", 7],
      ["editor", 6],
      ["auditor", 5],
      ["author", 4],
      ["contributor", 3],
      ["member", 2],
      ["viewer", 1],
    ],
  );
  assert.deepEqual(
    DEFAULT_ROLES.filter((role) => role.is_protected).map((role) => role.slug),
    ["owner", "super_admin"],
  );
  assert.equal(DEFAULT_ROLES.find((role) => role.slug === "owner")?.is_assignable, false);
  assert.ok(DEFAULT_ROLES.every((role) => role.is_system === true));

  const insertedValues = operations.find((entry) => entry[0] === "values")?.[1] ?? [];
  assert.equal(insertedValues.length, DEFAULT_ROLES.length);
});

test("default role seed down removes the seeded role ids", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await down(db);

  assert.deepEqual(operations.filter((entry) => ["deleteFrom", "where"].includes(entry[0])), [
    ["deleteFrom", "roles"],
    ["where", "roles", "id", "in", DEFAULT_ROLES.map((role) => role.id)],
  ]);
});
