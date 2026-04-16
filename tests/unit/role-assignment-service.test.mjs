import test from "node:test";
import assert from "node:assert/strict";

import { createRoleAssignmentService, RoleAssignmentError } from "../../src/services/roles/service.mjs";

function createFakeDatabase() {
  const state = {
    roles: [],
    user_roles: [],
    users: [],
    audit_logs: [],
    transactions: 0,
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            if (table === "user_roles") {
              state.user_roles.push({
                assigned_at: values.assigned_at ?? "2026-01-01T00:00:00.000Z",
                expires_at: values.expires_at ?? null,
                assigned_by_user_id: values.assigned_by_user_id ?? null,
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
      const local = {
        where: [],
        limit: undefined,
        offset: undefined,
        orderBy: [],
      };

      const source = table === "users" ? state.users : table === "roles" ? state.roles : table === "audit_logs" ? state.audit_logs : state.user_roles;

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

    updateTable(table) {
      const source = table === "user_roles" ? state.user_roles : state.users;
      const updateState = { values: undefined, where: [] };

      return {
        set: (values) => {
          updateState.values = values;

          const chain = {
            where: (column, operator, value) => {
              updateState.where.push({ column, operator, value });
              return chain;
            },
            execute: async () => {
              for (const row of source) {
                const matches = updateState.where.every((clause) => {
                  if (clause.operator === "=" || clause.operator === "is") return row[clause.column] === clause.value;
                  if (clause.operator === "is not") return row[clause.column] !== clause.value;
                  return false;
                });

                if (!matches) continue;

                for (const [key, nextValue] of Object.entries(updateState.values)) {
                  row[key] = nextValue !== null && typeof nextValue === "object" ? "2026-01-02T00:00:00.000Z" : nextValue;
                }
              }
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

function seedBaseState(state) {
  state.users.push({
    id: "user_1",
    email: "user@example.com",
    status: "active",
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  state.roles.push(
    {
      id: "role_editor",
      slug: "editor",
      name: "Editor",
      staff_level: 6,
      is_system: true,
      is_assignable: true,
      is_protected: false,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "role_admin",
      slug: "admin",
      name: "Admin",
      staff_level: 8,
      is_system: true,
      is_assignable: true,
      is_protected: false,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "role_owner",
      slug: "owner",
      name: "Owner",
      staff_level: 10,
      is_system: true,
      is_assignable: false,
      is_protected: true,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  );
}

test("role assignment service assigns and lists active roles with automatic primary selection", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRoleAssignmentService({ database });

  const assigned = await service.assignRole({
    id: "assign_1",
    user_id: "user_1",
    role_id: "role_editor",
    assigned_by_user_id: "admin_1",
  });

  assert.equal(assigned.is_primary, true);
  assert.equal(assigned.role.slug, "editor");

  const active = await service.listActiveRoles("user_1");
  assert.equal(active.length, 1);
  assert.equal(active[0].role.slug, "editor");
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["role.assign"]);
  assert.equal(state.transactions, 2);
});

test("role assignment service preserves history when replacing the primary role", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRoleAssignmentService({ database });

  await service.assignRole({
    id: "assign_1",
    user_id: "user_1",
    role_id: "role_editor",
  });

  const reassigned = await service.assignRole({
    id: "assign_2",
    user_id: "user_1",
    role_id: "role_admin",
    is_primary: true,
  });

  assert.equal(reassigned.role.slug, "admin");
  assert.equal(reassigned.is_primary, true);
  assert.equal(state.user_roles.length, 2);
  assert.equal(state.user_roles[0].expires_at !== null, true);
  assert.equal(state.user_roles[1].expires_at, null);

  const active = await service.listActiveRoles("user_1");
  assert.deepEqual(active.map((assignment) => assignment.role.slug), ["admin"]);
});

test("role assignment service revokes active assignments by expiring them", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRoleAssignmentService({ database });

  await service.assignRole({
    id: "assign_1",
    user_id: "user_1",
    role_id: "role_editor",
  });

  const revoked = await service.revokeRole({
    user_id: "user_1",
    role_id: "role_editor",
    revoked_by_user_id: "admin_1",
    expires_at: "2026-01-10T00:00:00.000Z",
  });

  assert.equal(revoked.expires_at, "2026-01-10T00:00:00.000Z");

  const active = await service.listActiveRoles("user_1");
  assert.equal(active.length, 0);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["role.assign", "role.revoke"]);
});

test("role assignment service exposes pluggable protection hooks", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const calls = [];
  const service = createRoleAssignmentService({
    database,
    hooks: {
      async beforeAssignRole(context) {
        calls.push(["assign", context.user.id, context.role.slug, context.next_is_primary]);
      },
      async beforeRevokeRole(context) {
        calls.push(["revoke", context.user.id, context.role.slug]);
        return false;
      },
    },
  });

  await service.assignRole({
    id: "assign_1",
    user_id: "user_1",
    role_id: "role_editor",
  });

  await assert.rejects(
    () =>
      service.revokeRole({
        user_id: "user_1",
        role_id: "role_editor",
      }),
    (error) => error instanceof RoleAssignmentError && error.code === "REVOCATION_DENIED",
  );

  assert.deepEqual(calls, [
    ["assign", "user_1", "editor", true],
    ["revoke", "user_1", "editor"],
  ]);
});

test("role assignment service requires explicit confirmation for protected role changes", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRoleAssignmentService({ database });

  await assert.rejects(
    () =>
      service.assignRole({
        id: "assign_owner",
        user_id: "user_1",
        role_id: "role_owner",
      }),
    (error) => error instanceof RoleAssignmentError && error.code === "PROTECTED_ROLE_CONFIRMATION_REQUIRED",
  );

  const assigned = await service.assignRole({
    id: "assign_owner",
    user_id: "user_1",
    role_id: "role_owner",
    confirm_protected_role_change: true,
  });

  assert.equal(assigned.role.slug, "owner");

  await assert.rejects(
    () =>
      service.revokeRole({
        user_id: "user_1",
        role_id: "role_owner",
      }),
    (error) => error instanceof RoleAssignmentError && error.code === "PROTECTED_ROLE_CONFIRMATION_REQUIRED",
  );
});
