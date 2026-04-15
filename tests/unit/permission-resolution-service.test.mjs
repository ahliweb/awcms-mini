import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PERMISSIONS } from "../../src/db/migrations/014_default_permissions.mjs";
import { DEFAULT_ROLES } from "../../src/db/migrations/015_default_roles.mjs";
import { DEFAULT_ROLE_PERMISSIONS } from "../../src/db/migrations/016_default_role_permissions.mjs";
import { createPermissionResolutionService } from "../../src/services/permissions/service.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    user_roles: [],
    roles: [],
    role_permissions: [],
    permissions: [],
    transactions: 0,
  };

  const executor = {
    selectFrom(table) {
      const local = {
        where: [],
        limit: undefined,
        offset: undefined,
        orderBy: [],
      };

      const source = state[table];

      const apply = () => {
        let rows = [...source];

        for (const clause of local.where) {
          if (clause.operator === "=" || clause.operator === "is") {
            rows = rows.filter((row) => row[clause.column] === clause.value);
          } else if (clause.operator === "is not") {
            rows = rows.filter((row) => row[clause.column] !== clause.value);
          }
        }

        rows.sort((left, right) => {
          for (const clause of local.orderBy) {
            const leftValue = String(left[clause.column] ?? "");
            const rightValue = String(right[clause.column] ?? "");
            const comparison = leftValue.localeCompare(rightValue);

            if (comparison !== 0) {
              return clause.direction === "desc" ? -comparison : comparison;
            }
          }

          return 0;
        });

        if (local.offset !== undefined) rows = rows.slice(local.offset);
        if (local.limit !== undefined) rows = rows.slice(0, local.limit);

        return rows;
      };

      const query = {
        select: () => query,
        where: (column, operator, value) => {
          local.where.push({ column, operator, value });
          return query;
        },
        orderBy: (column, direction = "asc") => {
          local.orderBy.push({ column, direction });
          return query;
        },
        limit: (limit) => {
          local.limit = limit;
          return query;
        },
        offset: (offset) => {
          local.offset = offset;
          return query;
        },
        execute: async () => apply(),
        executeTakeFirst: async () => apply()[0],
      };

      return query;
    },

    startTransaction() {
      return {
        execute: async () => {
          state.transactions += 1;
          return {
            ...executor,
            commit() {
              return { execute: async () => {} };
            },
            rollback() {
              return { execute: async () => {} };
            },
            savepoint() {
              return {
                execute: async () => ({
                  ...executor,
                  releaseSavepoint() {
                    return { execute: async () => {} };
                  },
                  rollbackToSavepoint() {
                    return { execute: async () => {} };
                  },
                }),
              };
            },
          };
        },
      };
    },
  };

  return { database: executor, state };
}

function seedDefaultRbacState(state) {
  state.users.push(
    {
      id: "user_editor",
      email: "editor@example.com",
      status: "active",
      deleted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "user_admin_security",
      email: "admin-security@example.com",
      status: "active",
      deleted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  );

  state.roles.push(
    ...DEFAULT_ROLES.map((role) => ({
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
      deleted_by_user_id: null,
      delete_reason: null,
      ...role,
    })),
  );

  state.permissions.push(
    ...DEFAULT_PERMISSIONS.map((permission) => ({
      created_at: "2026-01-01T00:00:00.000Z",
      ...permission,
    })),
  );

  state.role_permissions.push(
    ...DEFAULT_ROLE_PERMISSIONS.map((entry) => ({
      granted_at: "2026-01-01T00:00:00.000Z",
      ...entry,
    })),
  );

  state.user_roles.push(
    {
      id: "assign_editor",
      user_id: "user_editor",
      role_id: "role_editor",
      assigned_by_user_id: null,
      assigned_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      is_primary: true,
    },
    {
      id: "assign_admin",
      user_id: "user_admin_security",
      role_id: "role_admin",
      assigned_by_user_id: null,
      assigned_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      is_primary: true,
    },
    {
      id: "assign_security",
      user_id: "user_admin_security",
      role_id: "role_security_admin",
      assigned_by_user_id: null,
      assigned_at: "2026-01-02T00:00:00.000Z",
      expires_at: null,
      is_primary: false,
    },
  );
}

test("permission resolution service returns explicit effective permissions for a default editor", async () => {
  const { database, state } = createFakeDatabase();
  seedDefaultRbacState(state);
  const service = createPermissionResolutionService({ database });

  const resolved = await service.getEffectivePermissions("user_editor");

  assert.deepEqual(resolved.roles.map((role) => role.slug), ["editor"]);
  assert.deepEqual(resolved.permission_codes, [
    "content.posts.create",
    "content.posts.publish",
    "content.posts.read",
    "content.posts.update",
  ]);
  assert.equal(resolved.cache_hit, false);
  assert.equal(state.transactions, 1);
});

test("permission resolution service unions permissions across multiple default roles", async () => {
  const { database, state } = createFakeDatabase();
  seedDefaultRbacState(state);
  const service = createPermissionResolutionService({ database });

  const resolved = await service.getEffectivePermissions("user_admin_security");

  assert.deepEqual(resolved.roles.map((role) => role.slug), ["admin", "security_admin"]);
  assert.equal(resolved.permission_codes.includes("admin.permissions.update"), true);
  assert.equal(resolved.permission_codes.includes("security.2fa.reset"), true);
  assert.equal(resolved.permission_codes.includes("audit.logs.export"), true);
  assert.equal(new Set(resolved.permission_codes).size, resolved.permission_codes.length);
});

test("permission resolution service supports cache hook points", async () => {
  const { database, state } = createFakeDatabase();
  seedDefaultRbacState(state);
  const stored = [];
  const service = createPermissionResolutionService({
    database,
    hooks: {
      async getCachedPermissions({ user_id }) {
        if (user_id === "cached_user") {
          return {
            user_id,
            assignments: [],
            roles: [],
            permissions: [],
            permission_codes: ["cached.permission.read"],
            resolved_at: "2026-01-03T00:00:00.000Z",
          };
        }

        return undefined;
      },
      async storeResolvedPermissions(resolution) {
        stored.push(resolution.user_id);
      },
    },
  });

  const cached = await service.getEffectivePermissions("cached_user");
  assert.deepEqual(cached.permission_codes, ["cached.permission.read"]);
  assert.equal(cached.cache_hit, true);

  const resolved = await service.getEffectivePermissions("user_editor");
  assert.equal(resolved.cache_hit, false);
  assert.deepEqual(stored, ["user_editor"]);
});
