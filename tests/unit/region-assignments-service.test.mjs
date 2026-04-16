import test from "node:test";
import assert from "node:assert/strict";

import { createRegionAssignmentService, RegionAssignmentError } from "../../src/services/regions/assignments.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    regions: [],
    user_region_assignments: [],
    audit_logs: [],
    transactions: 0,
  };

  const executor = {
    insertInto(table) {
      return {
        values: (values) => ({
          execute: async () => {
            state[table].push({
              created_at: values.created_at ?? "2026-01-01T00:00:00.000Z",
              updated_at: values.updated_at ?? "2026-01-01T00:00:00.000Z",
              deleted_at: values.deleted_at ?? null,
              ends_at: values.ends_at ?? null,
              sort_order: values.sort_order ?? 0,
              is_active: values.is_active ?? true,
              is_primary: values.is_primary ?? false,
              assignment_type: values.assignment_type ?? "member",
              ...values,
            });
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
      const source = state[table];
      const local = { values: undefined, where: [] };

      return {
        set: (values) => {
          local.values = values;
          const chain = {
            where: (column, operator, value) => {
              local.where.push({ column, operator, value });
              return chain;
            },
            execute: async () => {
              for (const row of source) {
                const matches = local.where.every((clause) => {
                  if (clause.operator === "=" || clause.operator === "is") return row[clause.column] === clause.value;
                  if (clause.operator === "is not") return row[clause.column] !== clause.value;
                  return false;
                });

                if (!matches) continue;

                for (const [key, nextValue] of Object.entries(local.values)) {
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
  state.users.push(
    { id: "user_1", status: "active", deleted_at: null },
    { id: "user_2", status: "active", deleted_at: null },
  );

  state.regions.push(
    { id: "region_1", code: "north", name: "North", path: "region_1", level: 1, is_active: true, deleted_at: null },
    { id: "region_2", code: "south", name: "South", path: "region_2", level: 1, is_active: true, deleted_at: null },
    { id: "region_3", code: "archived", name: "Archived", path: "region_3", level: 1, is_active: false, deleted_at: null },
  );
}

test("region assignment service assigns the first region as primary and lists active assignments", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRegionAssignmentService({ database });

  const assigned = await service.assignRegion({
    id: "assignment_1",
    user_id: "user_1",
    region_id: "region_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(assigned.is_primary, true);

  const active = await service.listActiveRegions("user_1");
  assert.deepEqual(active.map((entry) => entry.id), ["assignment_1"]);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["region.assign"]);
  assert.equal(state.transactions, 2);
});

test("region assignment service enforces one active primary assignment when changing the primary region", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRegionAssignmentService({ database });

  await service.assignRegion({
    id: "assignment_1",
    user_id: "user_1",
    region_id: "region_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  const changed = await service.changeRegion({
    id: "assignment_2",
    assignment_id: "assignment_1",
    region_id: "region_2",
    starts_at: "2026-02-01T00:00:00.000Z",
    is_primary: true,
  });

  assert.equal(changed.region_id, "region_2");
  assert.equal(state.user_region_assignments.find((entry) => entry.id === "assignment_1").ends_at, "2026-02-01T00:00:00.000Z");

  const active = await service.listActiveRegions("user_1");
  assert.deepEqual(active.map((entry) => entry.id), ["assignment_2"]);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["region.assign", "region.change"]);
});

test("region assignment service ends active assignments without deleting history", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRegionAssignmentService({ database });

  await service.assignRegion({
    id: "assignment_1",
    user_id: "user_1",
    region_id: "region_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  const ended = await service.endRegion({
    assignment_id: "assignment_1",
    ends_at: "2026-03-01T00:00:00.000Z",
  });

  assert.equal(ended.ends_at, "2026-03-01T00:00:00.000Z");
  assert.equal((await service.listActiveRegions("user_1")).length, 0);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["region.assign", "region.end"]);
});

test("region assignment service rejects unavailable regions and duplicate active signatures on change", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createRegionAssignmentService({ database });

  await assert.rejects(
    () =>
      service.assignRegion({
        id: "assignment_bad",
        user_id: "user_1",
        region_id: "region_3",
        starts_at: "2026-01-01T00:00:00.000Z",
      }),
    (error) => error instanceof RegionAssignmentError && error.code === "REGION_NOT_FOUND",
  );

  await service.assignRegion({
    id: "assignment_1",
    user_id: "user_1",
    region_id: "region_1",
    assignment_type: "manager",
    starts_at: "2026-01-01T00:00:00.000Z",
    is_primary: true,
  });

  await service.assignRegion({
    id: "assignment_2",
    user_id: "user_1",
    region_id: "region_2",
    assignment_type: "member",
    starts_at: "2026-01-10T00:00:00.000Z",
    is_primary: false,
  });

  await assert.rejects(
    () =>
      service.changeRegion({
        id: "assignment_3",
        assignment_id: "assignment_2",
        region_id: "region_1",
        assignment_type: "manager",
        starts_at: "2026-02-01T00:00:00.000Z",
      }),
    (error) => error instanceof RegionAssignmentError && error.code === "REGION_ASSIGNMENT_ALREADY_ACTIVE",
  );
});
