import test from "node:test";
import assert from "node:assert/strict";

import { buildPermissionPatch, createPermissionRepository } from "../../src/db/repositories/permissions.mjs";
import { diffPermissionIds, createRolePermissionRepository } from "../../src/db/repositories/role-permissions.mjs";
import { buildRolePatch, createRoleRepository } from "../../src/db/repositories/roles.mjs";

class FakeRbacExecutor {
  constructor() {
    this.roles = [];
    this.permissions = [];
    this.role_permissions = [];
  }

  insertInto(table) {
    const source = this[table];
    assert.ok(Array.isArray(source));

    return {
      values: (values) => ({
        execute: async () => {
          const items = Array.isArray(values) ? values : [values];

          for (const item of items) {
            source.push({
              created_at: item.created_at ?? "2026-01-01T00:00:00.000Z",
              updated_at: item.updated_at ?? "2026-01-01T00:00:00.000Z",
              granted_at: item.granted_at ?? "2026-01-01T00:00:00.000Z",
              deleted_at: item.deleted_at ?? null,
              deleted_by_user_id: item.deleted_by_user_id ?? null,
              delete_reason: item.delete_reason ?? null,
              ...item,
            });
          }
        },
      }),
    };
  }

  selectFrom(table) {
    const source = this[table];
    assert.ok(Array.isArray(source));

    const state = {
      where: [],
      limit: undefined,
      offset: undefined,
      orderBy: [],
    };

    const apply = () => {
      let rows = [...source];

      for (const clause of state.where) {
        if (clause.operator === "=") {
          rows = rows.filter((row) => row[clause.column] === clause.value);
        } else if (clause.operator === "is") {
          rows = rows.filter((row) => row[clause.column] === clause.value);
        } else if (clause.operator === "is not") {
          rows = rows.filter((row) => row[clause.column] !== clause.value);
        }
      }

      rows.sort((left, right) => {
        for (const clause of state.orderBy) {
          const leftValue = String(left[clause.column] ?? "");
          const rightValue = String(right[clause.column] ?? "");
          const comparison = leftValue.localeCompare(rightValue);

          if (comparison !== 0) {
            return clause.direction === "desc" ? -comparison : comparison;
          }
        }

        return 0;
      });

      if (state.offset !== undefined) {
        rows = rows.slice(state.offset);
      }

      if (state.limit !== undefined) {
        rows = rows.slice(0, state.limit);
      }

      return rows;
    };

    const query = {
      select: () => query,
      where: (column, operator, value) => {
        state.where.push({ column, operator, value });
        return query;
      },
      orderBy: (column, direction = "asc") => {
        state.orderBy.push({ column, direction });
        return query;
      },
      limit: (limit) => {
        state.limit = limit;
        return query;
      },
      offset: (offset) => {
        state.offset = offset;
        return query;
      },
      execute: async () => apply(),
      executeTakeFirst: async () => apply()[0],
    };

    return query;
  }

  updateTable(table) {
    const source = this[table];
    assert.ok(Array.isArray(source));

    const state = {
      values: undefined,
      where: [],
    };

    return {
      set: (values) => {
        state.values = values;

        const chain = {
          where: (column, operator, value) => {
            state.where.push({ column, operator, value });
            return chain;
          },
          execute: async () => {
            for (const row of source) {
              const matches = state.where.every((clause) => {
                if (clause.operator === "=") return row[clause.column] === clause.value;
                if (clause.operator === "is") return row[clause.column] === clause.value;
                if (clause.operator === "is not") return row[clause.column] !== clause.value;
                return false;
              });

              if (!matches) continue;

              for (const [key, nextValue] of Object.entries(state.values)) {
                row[key] = nextValue !== null && typeof nextValue === "object" ? "2026-01-02T00:00:00.000Z" : nextValue;
              }
            }
          },
        };

        return chain;
      },
    };
  }

  deleteFrom(table) {
    const source = this[table];
    assert.ok(Array.isArray(source));

    const state = {
      where: [],
    };

    const chain = {
      where: (column, operator, value) => {
        state.where.push({ column, operator, value });
        return chain;
      },
      execute: async () => {
        for (let index = source.length - 1; index >= 0; index -= 1) {
          const row = source[index];
          const matches = state.where.every((clause) => {
            if (clause.operator === "=") return row[clause.column] === clause.value;
            if (clause.operator === "in") return clause.value.includes(row[clause.column]);
            return false;
          });

          if (matches) {
            source.splice(index, 1);
          }
        }
      },
    };

    return chain;
  }
}

test("buildRolePatch filters unsupported fields and adds updated_at", () => {
  const patch = buildRolePatch({ name: "Updated", random: true });

  assert.equal(patch.name, "Updated");
  assert.equal(Object.hasOwn(patch, "random"), false);
  assert.equal(Object.hasOwn(patch, "updated_at"), true);
});

test("buildPermissionPatch filters unsupported fields", () => {
  const patch = buildPermissionPatch({ description: "Updated", random: true });

  assert.equal(patch.description, "Updated");
  assert.equal(Object.hasOwn(patch, "random"), false);
});

test("role repository supports create/get/list/update/delete flows", async () => {
  const executor = new FakeRbacExecutor();
  const repo = createRoleRepository(executor);

  const created = await repo.createRole({
    id: "role_1",
    slug: "editor",
    name: "Editor",
    staff_level: 6,
    is_system: true,
  });

  assert.equal(created.slug, "editor");
  assert.equal(created.is_assignable, true);

  const bySlug = await repo.getRoleBySlug("editor");
  assert.equal(bySlug.id, "role_1");

  const updated = await repo.updateRole("role_1", { name: "Senior Editor", is_protected: true });
  assert.equal(updated.name, "Senior Editor");
  assert.equal(updated.is_protected, true);

  const listed = await repo.listRoles({ is_system: true });
  assert.equal(listed.length, 1);

  const deleted = await repo.softDeleteRole("role_1", { delete_reason: "cleanup" });
  assert.equal(deleted.delete_reason, "cleanup");

  const hidden = await repo.getRoleById("role_1");
  assert.equal(hidden, undefined);
});

test("permission repository supports create/get/list/update flows", async () => {
  const executor = new FakeRbacExecutor();
  const repo = createPermissionRepository(executor);

  const created = await repo.createPermission({
    id: "perm_1",
    code: "content.posts.read",
    domain: "content",
    resource: "posts",
    action: "read",
  });

  assert.equal(created.code, "content.posts.read");
  assert.equal(created.is_protected, false);

  const byCode = await repo.getPermissionByCode("content.posts.read");
  assert.equal(byCode.id, "perm_1");

  await repo.createPermission({
    id: "perm_2",
    code: "security.sessions.revoke",
    domain: "security",
    resource: "sessions",
    action: "revoke",
    is_protected: true,
  });

  const protectedPermissions = await repo.listPermissions({ is_protected: true });
  assert.equal(protectedPermissions.length, 1);
  assert.equal(protectedPermissions[0].id, "perm_2");

  const updated = await repo.updatePermission("perm_1", { description: "Read posts" });
  assert.equal(updated.description, "Read posts");
});

test("role-permission repository supports grant, revoke, diff, and sync flows", async () => {
  const executor = new FakeRbacExecutor();
  const repo = createRolePermissionRepository(executor);

  await repo.grantPermissionToRole({ role_id: "role_editor", permission_id: "perm_read" });
  await repo.grantPermissionToRole({ role_id: "role_editor", permission_id: "perm_update" });
  await repo.grantPermissionToRole({ role_id: "role_admin", permission_id: "perm_update" });

  const listed = await repo.listRolePermissionsByRoleId("role_editor");
  assert.deepEqual(
    listed.map((entry) => entry.permission_id),
    ["perm_read", "perm_update"],
  );

  const roleIds = await repo.listRoleIdsByPermissionId("perm_update");
  assert.deepEqual(roleIds, ["role_admin", "role_editor"]);

  const diff = await repo.diffRolePermissionIds("role_editor", ["perm_update", "perm_publish"]);
  assert.deepEqual(diff, {
    currentPermissionIds: ["perm_read", "perm_update"],
    nextPermissionIds: ["perm_publish", "perm_update"],
    addPermissionIds: ["perm_publish"],
    removePermissionIds: ["perm_read"],
    unchangedPermissionIds: ["perm_update"],
  });

  const synced = await repo.syncRolePermissionIds("role_editor", ["perm_update", "perm_publish"], {
    granted_by_user_id: "user_admin",
  });

  assert.deepEqual(synced.addPermissionIds, ["perm_publish"]);
  assert.deepEqual(synced.removePermissionIds, ["perm_read"]);

  const afterSync = await repo.listRolePermissionsByRoleId("role_editor");
  assert.deepEqual(
    afterSync.map((entry) => [entry.permission_id, entry.granted_by_user_id]),
    [
      ["perm_publish", "user_admin"],
      ["perm_update", null],
    ],
  );
});

test("diffPermissionIds computes stable sorted additions and removals", () => {
  assert.deepEqual(diffPermissionIds(["perm_b", "perm_a"], ["perm_c", "perm_b"]), {
    currentPermissionIds: ["perm_a", "perm_b"],
    nextPermissionIds: ["perm_b", "perm_c"],
    addPermissionIds: ["perm_c"],
    removePermissionIds: ["perm_a"],
    unchangedPermissionIds: ["perm_b"],
  });
});
