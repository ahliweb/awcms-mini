import test from "node:test";
import assert from "node:assert/strict";

import {
  EDGE_API_PERMISSIONS,
  EDGE_API_ROLE_PERMISSION_CODES,
  EDGE_API_ROLE_PERMISSIONS,
  down,
  up,
} from "../../src/db/migrations/032_edge_api_permissions.mjs";

function createFakeSeedRecorder() {
  const operations = [];

  return {
    operations,
    db: {
      insertInto(table) {
        operations.push(["insertInto", table]);

        return {
          values(values) {
            operations.push(["values", table, values]);

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
        const whereCalls = [];

        return {
          where(column, operator, value) {
            whereCalls.push([column, operator, value]);
            operations.push(["where", table, column, operator, value]);

            return {
              where(nextColumn, nextOperator, nextValue) {
                whereCalls.push([nextColumn, nextOperator, nextValue]);
                operations.push(["where", table, nextColumn, nextOperator, nextValue]);

                return {
                  execute: async () => {
                    operations.push(["deleteExecute", table, whereCalls]);
                  },
                };
              },
              execute: async () => {
                operations.push(["deleteExecute", table, whereCalls]);
              },
            };
          },
        };
      },
    },
  };
}

test("edge api permissions migration seeds canonical self-service edge permissions", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await up(db);

  assert.deepEqual(EDGE_API_PERMISSIONS.map((permission) => permission.code), [
    "edge.api.session.read",
    "edge.api.session.revoke",
  ]);
  assert.ok(Object.values(EDGE_API_ROLE_PERMISSION_CODES).every((codes) => codes.length === 2));

  const permissionInsert = operations.find((entry) => entry[0] === "values" && entry[1] === "permissions");
  const rolePermissionInsert = operations.find((entry) => entry[0] === "values" && entry[1] === "role_permissions");

  assert.equal(permissionInsert?.[2].length, EDGE_API_PERMISSIONS.length);
  assert.equal(rolePermissionInsert?.[2].length, EDGE_API_ROLE_PERMISSIONS.length);
});

test("edge api permissions migration down removes seeded role grants and permissions", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await down(db);

  const rolePermissionDeletes = operations.filter((entry) => entry[0] === "deleteExecute" && entry[1] === "role_permissions");
  assert.equal(rolePermissionDeletes.length, EDGE_API_ROLE_PERMISSIONS.length);

  const permissionsDelete = operations.filter((entry) => entry[0] === "deleteExecute" && entry[1] === "permissions");
  assert.equal(permissionsDelete.length, 1);
});
