import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/021_regions.mjs";

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

test("regions migration defines hierarchy columns, path storage, and bounded depth", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "regions"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "regions" && entry[2] === "parent_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "regions" && entry[2] === "level"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "regions" && entry[2] === "path"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "regions" && entry[2] === "sort_order"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "regions" && entry[2] === "deleted_at"));
  assert.ok(operations.some((entry) => entry[0] === "addCheckConstraint" && entry[2] === "regions_level_min_check"));
  assert.ok(operations.some((entry) => entry[0] === "addCheckConstraint" && entry[2] === "regions_level_max_check"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "regions_code_index"));
  assert.ok(operations.some((entry) => entry[0] === "indexUnique" && entry[1] === "regions_code_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "regions_parent_id_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "regions_path_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "regions_level_index"));
});

test("regions migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "regions_deleted_at_index"],
      ["dropIndex", "regions_level_index"],
      ["dropIndex", "regions_path_index"],
      ["dropIndex", "regions_parent_id_index"],
      ["dropIndex", "regions_code_index"],
      ["dropTable", "regions"],
    ],
  );
});
