import test from "node:test";
import assert from "node:assert/strict";

import { createRbacService } from "../../src/services/rbac/service.mjs";

function createFakeDatabase() {
  const state = {
    roles: [
      { id: "role_owner", slug: "owner", name: "Owner", deleted_at: null },
      { id: "role_editor", slug: "editor", name: "Editor", deleted_at: null },
    ],
    permissions: [
      { id: "perm_admin_roles_assign", code: "admin.roles.assign" },
      { id: "perm_content_posts_read", code: "content.posts.read" },
    ],
    role_permissions: [
      { role_id: "role_owner", permission_id: "perm_admin_roles_assign", granted_by_user_id: null, granted_at: "2026-01-01T00:00:00.000Z" },
      { role_id: "role_editor", permission_id: "perm_content_posts_read", granted_by_user_id: null, granted_at: "2026-01-01T00:00:00.000Z" },
    ],
    audit_logs: [],
    transactions: 0,
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            if (table === "role_permissions") {
              state.role_permissions.push({
                granted_by_user_id: values.granted_by_user_id ?? null,
                granted_at: values.granted_at ?? "2026-01-01T00:00:00.000Z",
                ...values,
              });
            }

            if (table === "audit_logs") {
              state.audit_logs.push({
                occurred_at: values.occurred_at ?? "2026-01-01T00:00:00.000Z",
                metadata: values.metadata ?? {},
                before_payload: values.before_payload ?? null,
                after_payload: values.after_payload ?? null,
                ...values,
              });
            }
          },
        }),
      };
    },

    selectFrom(table) {
      const local = { where: [], orderBy: [], limit: undefined, offset: undefined };
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

    deleteFrom(table) {
      return {
        where: (column, operator, value) => {
          const filters = [{ column, operator, value }];
          const chain = {
            where: (nextColumn, nextOperator, nextValue) => {
              filters.push({ column: nextColumn, operator: nextOperator, value: nextValue });
              return chain;
            },
            execute: async () => {
              state[table] = state[table].filter((row) =>
                !filters.every((filter) => row[filter.column] === filter.value),
              );
            },
          };
          return chain;
        },
      };
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

test("rbac service applies permission matrix changes and audits before/after diffs", async () => {
  const { database, state } = createFakeDatabase();
  const service = createRbacService({ database });

  const diffs = await service.applyPermissionMatrix({
    actor_user_id: "admin_1",
    rolePermissionIdsByRoleId: {
      role_owner: ["perm_admin_roles_assign", "perm_content_posts_read"],
      role_editor: [],
    },
  });

  assert.deepEqual(diffs.role_owner.addPermissionIds, ["perm_content_posts_read"]);
  assert.deepEqual(diffs.role_editor.removePermissionIds, ["perm_content_posts_read"]);
  assert.equal(state.audit_logs.length, 2);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["permission.matrix.apply", "permission.matrix.apply"]);
  assert.deepEqual(state.audit_logs[0].before_payload.permission_ids, ["perm_admin_roles_assign"]);
  assert.deepEqual(state.audit_logs[0].after_payload.permission_ids, ["perm_admin_roles_assign", "perm_content_posts_read"]);
  assert.equal(state.transactions, 1);
});
