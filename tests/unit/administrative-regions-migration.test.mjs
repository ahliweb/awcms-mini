import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/024_administrative_regions.mjs";

function createFakeSchemaRecorder() {
  const operations = [];

  function createTableBuilder(table) {
    return {
      addColumn(name, type, callback) {
        operations.push(["addColumn", table, name, type]);
        if (callback) {
          const column = {
            primaryKey() {
              operations.push(["primaryKey", table, name]);
              return column;
            },
            notNull() {
              operations.push(["notNull", table, name]);
              return column;
            },
            defaultTo(value) {
              operations.push(["defaultTo", table, name, String(value)]);
              return column;
            },
            references(reference) {
              operations.push(["references", table, name, reference]);
              return column;
            },
            onDelete(value) {
              operations.push(["onDelete", table, name, value]);
              return column;
            },
          };
          callback(column);
        }
        return this;
      },
      addCheckConstraint(name, expression) {
        operations.push(["addCheckConstraint", table, name, String(expression)]);
        return this;
      },
      execute: async () => {
        operations.push(["createTableExecute", table]);
      },
    };
  }

  function createIndexBuilder(name) {
    return {
      on(table) {
        operations.push(["indexOn", name, table]);
        return this;
      },
      column(columnName) {
        operations.push(["indexColumn", name, columnName]);
        return this;
      },
      unique() {
        operations.push(["indexUnique", name]);
        return this;
      },
      execute: async () => {
        operations.push(["createIndexExecute", name]);
      },
    };
  }

  function dropIndexBuilder(name) {
    return {
      ifExists() {
        operations.push(["dropIndexIfExists", name]);
        return this;
      },
      execute: async () => {
        operations.push(["dropIndexExecute", name]);
      },
    };
  }

  function dropTableBuilder(table) {
    return {
      ifExists() {
        operations.push(["dropTableIfExists", table]);
        return this;
      },
      execute: async () => {
        operations.push(["dropTableExecute", table]);
      },
    };
  }

  return {
    operations,
    db: {
      schema: {
        createTable(table) {
          operations.push(["createTable", table]);
          return createTableBuilder(table);
        },
        createIndex(name) {
          operations.push(["createIndex", name]);
          return createIndexBuilder(name);
        },
        dropIndex(name) {
          operations.push(["dropIndex", name]);
          return dropIndexBuilder(name);
        },
        dropTable(table) {
          operations.push(["dropTable", table]);
          return dropTableBuilder(table);
        },
      },
    },
  };
}

test("administrative_regions migration defines hierarchy, type, and Indonesian code columns", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "administrative_regions"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "administrative_regions" && entry[2] === "type"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "administrative_regions" && entry[2] === "parent_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "administrative_regions" && entry[2] === "path"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "administrative_regions" && entry[2] === "province_code"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "administrative_regions" && entry[2] === "regency_code"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "administrative_regions" && entry[2] === "district_code"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "administrative_regions" && entry[2] === "village_code"));
  assert.ok(operations.some((entry) => entry[0] === "addCheckConstraint" && entry[2] === "administrative_regions_type_check"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "administrative_regions_code_index"));
  assert.ok(operations.some((entry) => entry[0] === "indexUnique" && entry[1] === "administrative_regions_code_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "administrative_regions_type_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "administrative_regions_province_code_index"));
});

test("administrative_regions migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "administrative_regions_village_code_index"],
      ["dropIndex", "administrative_regions_district_code_index"],
      ["dropIndex", "administrative_regions_regency_code_index"],
      ["dropIndex", "administrative_regions_province_code_index"],
      ["dropIndex", "administrative_regions_type_index"],
      ["dropIndex", "administrative_regions_path_index"],
      ["dropIndex", "administrative_regions_parent_id_index"],
      ["dropIndex", "administrative_regions_code_index"],
      ["dropTable", "administrative_regions"],
    ],
  );
});
