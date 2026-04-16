import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveAdministrativeRegionId,
  importAdministrativeRegions,
  resolveAdministrativeRegionImportOrder,
} from "../../src/db/importers/administrative-regions.mjs";

function createFakeDatabase() {
  const state = {
    administrative_regions: [],
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

test("deriveAdministrativeRegionId creates stable ids from codes", () => {
  assert.equal(deriveAdministrativeRegionId("Province-JB"), "administrative_region_province_jb");
});

test("resolveAdministrativeRegionImportOrder sorts parent chains before children", () => {
  const ordered = resolveAdministrativeRegionImportOrder([
    { code: "village-dago", parent_code: "district-coblong", name: "Dago", type: "village" },
    { code: "province-jb", parent_code: null, name: "Jawa Barat", type: "province" },
    { code: "district-coblong", parent_code: "regency-bdg", name: "Coblong", type: "district" },
    { code: "regency-bdg", parent_code: "province-jb", name: "Bandung", type: "regency_city" },
  ]);

  assert.deepEqual(ordered.map((entry) => entry.code), ["province-jb", "regency-bdg", "district-coblong", "village-dago"]);
});

test("administrative region importer performs an empty-db smoke import and is duplicate-safe", async () => {
  const { database, state } = createFakeDatabase();
  const records = [
    { code: "regency-bdg", name: "Bandung", type: "regency_city", parent_code: "province-jb", province_code: "32", regency_code: "32.04" },
    { code: "province-jb", name: "Jawa Barat", type: "province", province_code: "32" },
    { code: "district-coblong", name: "Coblong", type: "district", parent_code: "regency-bdg", province_code: "32", regency_code: "32.04", district_code: "32.04.10" },
  ];

  const first = await importAdministrativeRegions({ database, records });
  assert.equal(first.created, 3);
  assert.equal(first.updated, 0);
  assert.equal(state.administrative_regions.length, 3);
  assert.deepEqual(state.administrative_regions.map((entry) => entry.code), ["province-jb", "regency-bdg", "district-coblong"]);

  const second = await importAdministrativeRegions({
    database,
    records: [
      { code: "province-jb", name: "Jawa Barat Updated", type: "province", province_code: "32" },
      { code: "regency-bdg", name: "Bandung", type: "regency_city", parent_code: "province-jb", province_code: "32", regency_code: "32.04" },
      { code: "district-coblong", name: "Coblong", type: "district", parent_code: "regency-bdg", province_code: "32", regency_code: "32.04", district_code: "32.04.10" },
    ],
  });

  assert.equal(second.created, 0);
  assert.equal(second.updated, 3);
  assert.equal(state.administrative_regions.length, 3);
  assert.equal(state.administrative_regions.find((entry) => entry.code === "province-jb").name, "Jawa Barat Updated");
  assert.equal(state.transactions, 2);
});
