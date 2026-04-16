import test from "node:test";
import assert from "node:assert/strict";

import { createRegionService, MAX_REGION_DEPTH, RegionHierarchyError } from "../../src/services/regions/service.mjs";

function createFakeDatabase() {
  const state = {
    regions: [],
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
              sort_order: values.sort_order ?? 0,
              is_active: values.is_active ?? true,
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

                if (!matches) {
                  continue;
                }

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

function seedRegion(state, region) {
  state.regions.push({
    created_at: region.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: region.updated_at ?? "2026-01-01T00:00:00.000Z",
    deleted_at: region.deleted_at ?? null,
    sort_order: region.sort_order ?? 0,
    is_active: region.is_active ?? true,
    ...region,
  });
}

test("region service creates root and child regions with computed level and path", async () => {
  const { database, state } = createFakeDatabase();
  const service = createRegionService({ database });

  const root = await service.createRegion({ id: "region_root", code: "root", name: "Root" });
  const child = await service.createRegion({ id: "region_child", code: "child", name: "Child", parent_id: "region_root" });

  assert.equal(root.level, 1);
  assert.equal(root.path, "region_root");
  assert.equal(child.level, 2);
  assert.equal(child.path, "region_root/region_child");
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["region.create", "region.create"]);
  assert.equal(state.transactions, 2);
});

test("region service reparents a subtree and updates descendant levels and paths", async () => {
  const { database, state } = createFakeDatabase();
  const service = createRegionService({ database });

  seedRegion(state, { id: "root_a", code: "root-a", name: "Root A", parent_id: null, level: 1, path: "root_a" });
  seedRegion(state, { id: "root_b", code: "root-b", name: "Root B", parent_id: null, level: 1, path: "root_b" });
  seedRegion(state, { id: "north", code: "north", name: "North", parent_id: "root_a", level: 2, path: "root_a/north" });
  seedRegion(state, { id: "jakarta", code: "jakarta", name: "Jakarta", parent_id: "north", level: 3, path: "root_a/north/jakarta" });

  const subtree = await service.reparentRegion({ region_id: "north", parent_id: "root_b" });

  assert.deepEqual(subtree.map((entry) => [entry.id, entry.level, entry.path]), [
    ["north", 2, "root_b/north"],
    ["jakarta", 3, "root_b/north/jakarta"],
  ]);

  const north = state.regions.find((entry) => entry.id === "north");
  const jakarta = state.regions.find((entry) => entry.id === "jakarta");
  assert.equal(north.parent_id, "root_b");
  assert.equal(north.path, "root_b/north");
  assert.equal(jakarta.parent_id, "north");
  assert.equal(jakarta.path, "root_b/north/jakarta");
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["region.reparent"]);
});

test("region service rejects self-descendant reparent cycles", async () => {
  const { database, state } = createFakeDatabase();
  const service = createRegionService({ database });

  seedRegion(state, { id: "root", code: "root", name: "Root", parent_id: null, level: 1, path: "root" });
  seedRegion(state, { id: "north", code: "north", name: "North", parent_id: "root", level: 2, path: "root/north" });
  seedRegion(state, { id: "jakarta", code: "jakarta", name: "Jakarta", parent_id: "north", level: 3, path: "root/north/jakarta" });

  await assert.rejects(
    () => service.reparentRegion({ region_id: "north", parent_id: "jakarta" }),
    (error) => error instanceof RegionHierarchyError && error.code === "REGION_PARENT_CYCLE",
  );
});

test("region service enforces the fixed max depth during create and reparent", async () => {
  const { database, state } = createFakeDatabase();
  const service = createRegionService({ database });

  seedRegion(state, { id: "r1", code: "r1", name: "R1", parent_id: null, level: 1, path: "r1" });
  seedRegion(state, { id: "r2", code: "r2", name: "R2", parent_id: "r1", level: 2, path: "r1/r2" });
  seedRegion(state, { id: "r3", code: "r3", name: "R3", parent_id: "r2", level: 3, path: "r1/r2/r3" });
  seedRegion(state, { id: "r4", code: "r4", name: "R4", parent_id: "r3", level: 4, path: "r1/r2/r3/r4" });
  seedRegion(state, { id: "r5", code: "r5", name: "R5", parent_id: "r4", level: 5, path: "r1/r2/r3/r4/r5" });
  seedRegion(state, { id: "r6", code: "r6", name: "R6", parent_id: "r5", level: 6, path: "r1/r2/r3/r4/r5/r6" });
  seedRegion(state, { id: "r7", code: "r7", name: "R7", parent_id: "r6", level: 7, path: "r1/r2/r3/r4/r5/r6/r7" });
  seedRegion(state, { id: "r8", code: "r8", name: "R8", parent_id: "r7", level: 8, path: "r1/r2/r3/r4/r5/r6/r7/r8" });
  seedRegion(state, { id: "r9", code: "r9", name: "R9", parent_id: "r8", level: 9, path: "r1/r2/r3/r4/r5/r6/r7/r8/r9" });
  seedRegion(state, { id: "r10", code: "r10", name: "R10", parent_id: "r9", level: 10, path: "r1/r2/r3/r4/r5/r6/r7/r8/r9/r10" });
  seedRegion(state, { id: "p1", code: "p1", name: "P1", parent_id: null, level: 1, path: "p1" });
  seedRegion(state, { id: "p2", code: "p2", name: "P2", parent_id: "p1", level: 2, path: "p1/p2" });
  seedRegion(state, { id: "p3", code: "p3", name: "P3", parent_id: "p2", level: 3, path: "p1/p2/p3" });
  seedRegion(state, { id: "p4", code: "p4", name: "P4", parent_id: "p3", level: 4, path: "p1/p2/p3/p4" });
  seedRegion(state, { id: "p5", code: "p5", name: "P5", parent_id: "p4", level: 5, path: "p1/p2/p3/p4/p5" });
  seedRegion(state, { id: "p6", code: "p6", name: "P6", parent_id: "p5", level: 6, path: "p1/p2/p3/p4/p5/p6" });
  seedRegion(state, { id: "p7", code: "p7", name: "P7", parent_id: "p6", level: 7, path: "p1/p2/p3/p4/p5/p6/p7" });
  seedRegion(state, { id: "p8", code: "p8", name: "P8", parent_id: "p7", level: 8, path: "p1/p2/p3/p4/p5/p6/p7/p8" });

  await assert.rejects(
    () => service.createRegion({ id: "r11", code: "r11", name: "R11", parent_id: "r10" }),
    (error) => error instanceof RegionHierarchyError && error.code === "REGION_DEPTH_LIMIT_EXCEEDED",
  );

  await assert.rejects(
    () => service.reparentRegion({ region_id: "r8", parent_id: "p8" }),
    (error) => error instanceof RegionHierarchyError && error.code === "REGION_DEPTH_LIMIT_EXCEEDED",
  );

  assert.equal(MAX_REGION_DEPTH, 10);
});

test("region service audits updates", async () => {
  const { database, state } = createFakeDatabase();
  const service = createRegionService({ database });

  seedRegion(state, { id: "root", code: "root", name: "Root", parent_id: null, level: 1, path: "root" });

  const updated = await service.updateRegion({ region_id: "root", name: "Root Updated", sort_order: 2, is_active: false });

  assert.equal(updated.name, "Root Updated");
  assert.equal(updated.is_active, false);
  assert.deepEqual(state.audit_logs.map((entry) => entry.action), ["region.update"]);
});
