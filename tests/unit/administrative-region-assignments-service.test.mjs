import test from "node:test";
import assert from "node:assert/strict";

import {
  AdministrativeRegionAssignmentError,
  createAdministrativeRegionAssignmentService,
} from "../../src/services/administrative-regions/assignments.mjs";

function createFakeDatabase() {
  const state = {
    users: [],
    administrative_regions: [],
    user_administrative_region_assignments: [],
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
              ends_at: values.ends_at ?? null,
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

  state.administrative_regions.push(
    { id: "region_1", code: "province-jb", name: "Jawa Barat", type: "province", path: "region_1", is_active: true },
    { id: "region_2", code: "regency-bdg", name: "Bandung", type: "regency_city", path: "region_1/region_2", is_active: true },
    { id: "region_3", code: "inactive", name: "Inactive", type: "district", path: "region_3", is_active: false },
  );
}

test("administrative region assignment service assigns the first region as primary and lists active assignments", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createAdministrativeRegionAssignmentService({ database });

  const assigned = await service.assignAdministrativeRegion({
    id: "assignment_1",
    user_id: "user_1",
    administrative_region_id: "region_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(assigned.is_primary, true);

  const active = await service.listActiveAdministrativeRegions("user_1");
  assert.deepEqual(active.map((entry) => entry.id), ["assignment_1"]);
  assert.equal(state.transactions, 2);
});

test("administrative region assignment service enforces one active primary assignment when changing the primary region", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createAdministrativeRegionAssignmentService({ database });

  await service.assignAdministrativeRegion({
    id: "assignment_1",
    user_id: "user_1",
    administrative_region_id: "region_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  const changed = await service.changeAdministrativeRegion({
    id: "assignment_2",
    assignment_id: "assignment_1",
    administrative_region_id: "region_2",
    starts_at: "2026-02-01T00:00:00.000Z",
    is_primary: true,
  });

  assert.equal(changed.administrative_region_id, "region_2");
  assert.equal(
    state.user_administrative_region_assignments.find((entry) => entry.id === "assignment_1").ends_at,
    "2026-02-01T00:00:00.000Z",
  );

  const active = await service.listActiveAdministrativeRegions("user_1");
  assert.deepEqual(active.map((entry) => entry.id), ["assignment_2"]);
});

test("administrative region assignment service ends active assignments without deleting history", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createAdministrativeRegionAssignmentService({ database });

  await service.assignAdministrativeRegion({
    id: "assignment_1",
    user_id: "user_1",
    administrative_region_id: "region_1",
    starts_at: "2026-01-01T00:00:00.000Z",
  });

  const ended = await service.endAdministrativeRegion({
    assignment_id: "assignment_1",
    ends_at: "2026-03-01T00:00:00.000Z",
  });

  assert.equal(ended.ends_at, "2026-03-01T00:00:00.000Z");
  assert.equal((await service.listActiveAdministrativeRegions("user_1")).length, 0);
});

test("administrative region assignment service rejects unavailable regions and duplicate active signatures on change", async () => {
  const { database, state } = createFakeDatabase();
  seedBaseState(state);
  const service = createAdministrativeRegionAssignmentService({ database });

  await assert.rejects(
    () =>
      service.assignAdministrativeRegion({
        id: "assignment_bad",
        user_id: "user_1",
        administrative_region_id: "region_3",
        starts_at: "2026-01-01T00:00:00.000Z",
      }),
    (error) =>
      error instanceof AdministrativeRegionAssignmentError && error.code === "ADMINISTRATIVE_REGION_NOT_FOUND",
  );

  await service.assignAdministrativeRegion({
    id: "assignment_1",
    user_id: "user_1",
    administrative_region_id: "region_1",
    assignment_type: "manager",
    starts_at: "2026-01-01T00:00:00.000Z",
    is_primary: true,
  });

  await service.assignAdministrativeRegion({
    id: "assignment_2",
    user_id: "user_1",
    administrative_region_id: "region_2",
    assignment_type: "member",
    starts_at: "2026-01-10T00:00:00.000Z",
    is_primary: false,
  });

  await assert.rejects(
    () =>
      service.changeAdministrativeRegion({
        id: "assignment_3",
        assignment_id: "assignment_2",
        administrative_region_id: "region_1",
        assignment_type: "manager",
        starts_at: "2026-02-01T00:00:00.000Z",
      }),
    (error) =>
      error instanceof AdministrativeRegionAssignmentError &&
      error.code === "ADMINISTRATIVE_REGION_ASSIGNMENT_ALREADY_ACTIVE",
  );
});
