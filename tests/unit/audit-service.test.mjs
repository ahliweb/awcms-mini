import test from "node:test";
import assert from "node:assert/strict";

import { createAuditService } from "../../src/services/audit/service.mjs";

function createFakeDatabase() {
  const state = {
    audit_logs: [],
    transactions: 0,
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
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
      const source = state[table];
      const local = { where: [], orderBy: [], limit: undefined, offset: undefined };

      const apply = () => {
        let rows = [...source];

        for (const clause of local.where) {
          if (clause.operator === "=" || clause.operator === "is") {
            rows = rows.filter((row) => row[clause.column] === clause.value);
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

test("audit service appends normalized audit logs consistently", async () => {
  const { database, state } = createFakeDatabase();
  const service = createAuditService({ database });

  const created = await service.append({
    id: "audit_1",
    actor_user_id: " admin_1 ",
    action: "user.disable",
    entity_type: "user",
    entity_id: " user_1 ",
    summary: " Disabled user ",
    metadata: null,
    before_payload: { status: "active" },
    after_payload: { status: "disabled" },
  });

  assert.equal(created.actor_user_id, "admin_1");
  assert.equal(created.entity_id, "user_1");
  assert.equal(created.summary, "Disabled user");
  assert.deepEqual(created.metadata, {});
  assert.equal(state.transactions, 1);
});

test("audit service lists logs and participates in transactions", async () => {
  const { database, state } = createFakeDatabase();
  const service = createAuditService({ database });

  await service.append({
    id: "audit_1",
    actor_user_id: "admin_1",
    action: "user.disable",
    entity_type: "user",
    entity_id: "user_1",
    target_user_id: "user_1",
  });
  await service.append({
    id: "audit_2",
    actor_user_id: "admin_2",
    action: "roles.assign",
    entity_type: "role_assignment",
    entity_id: "assign_1",
    target_user_id: "user_2",
  });

  const listed = await service.list({ actor_user_id: "admin_1" });
  assert.deepEqual(listed.map((row) => row.id), ["audit_1"]);
  assert.equal(state.transactions, 3);
});
