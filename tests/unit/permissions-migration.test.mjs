import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/011_permissions.mjs";

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

test("permissions migration defines unique codes and protected marker", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "permissions"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "permissions" && entry[2] === "code"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "permissions" && entry[2] === "is_protected"));
  assert.ok(operations.some((entry) => entry[0] === "addCheckConstraint" && entry[1] === "permissions" && entry[2] === "permissions_code_format_check"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "permissions_code_index"));
  assert.ok(operations.some((entry) => entry[0] === "indexUnique" && entry[1] === "permissions_code_index"));
});

test("permissions migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "permissions_domain_index"],
      ["dropIndex", "permissions_code_index"],
      ["dropTable", "permissions"],
    ],
  );
});
