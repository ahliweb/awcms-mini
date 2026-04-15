import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PERMISSIONS } from "../../src/db/migrations/014_default_permissions.mjs";
import { DEFAULT_ROLES } from "../../src/db/migrations/015_default_roles.mjs";
import {
  DEFAULT_ROLE_PERMISSIONS,
  ROLE_PERMISSION_CODES,
  down,
  up,
} from "../../src/db/migrations/016_default_role_permissions.mjs";

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

test("default role-permission seed gives every default role explicit grants", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await up(db);

  const seededRoleSlugs = Object.keys(ROLE_PERMISSION_CODES);
  assert.deepEqual(seededRoleSlugs, DEFAULT_ROLES.map((role) => role.slug));
  assert.ok(seededRoleSlugs.every((slug) => ROLE_PERMISSION_CODES[slug].length > 0));

  const insertedValues = operations.find((entry) => entry[0] === "values")?.[1] ?? [];
  assert.equal(insertedValues.length, DEFAULT_ROLE_PERMISSIONS.length);
  assert.ok(insertedValues.every((entry) => entry.role_id && entry.permission_id));
});

test("default role-permission seed limits protected permissions to high-trust roles", () => {
  const protectedPermissionIds = new Set(
    DEFAULT_PERMISSIONS.filter((permission) => permission.is_protected).map((permission) => permission.id),
  );
  const roleSlugById = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.id, role.slug]));

  const rolesWithProtectedPermissions = new Set(
    DEFAULT_ROLE_PERMISSIONS.filter((entry) => protectedPermissionIds.has(entry.permission_id)).map((entry) => roleSlugById[entry.role_id]),
  );

  assert.deepEqual([...rolesWithProtectedPermissions].sort(), ["admin", "auditor", "owner", "security_admin", "super_admin"]);
  assert.equal(ROLE_PERMISSION_CODES.viewer.includes("admin.permissions.update"), false);
  assert.equal(ROLE_PERMISSION_CODES.region_manager.includes("security.2fa.reset"), false);
});

test("default role-permission seed down removes the seeded mappings", async () => {
  const { db, operations } = createFakeSeedRecorder();

  await down(db);

  const deleteOperations = operations.filter((entry) => entry[0] === "deleteExecute");
  assert.equal(deleteOperations.length, DEFAULT_ROLE_PERMISSIONS.length);
  assert.deepEqual(deleteOperations[0], [
    "deleteExecute",
    "role_permissions",
    [
      ["role_id", "=", DEFAULT_ROLE_PERMISSIONS[0].role_id],
      ["permission_id", "=", DEFAULT_ROLE_PERMISSIONS[0].permission_id],
    ],
  ]);
});
