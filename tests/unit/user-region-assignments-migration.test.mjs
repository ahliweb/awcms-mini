import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/022_user_region_assignments.mjs";

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
      columns(columnNames) {
        operations.push(["indexColumns", name, columnNames]);
        return this;
      },
      unique() {
        operations.push(["indexUnique", name]);
        return this;
      },
      where(expression) {
        operations.push(["indexWhere", name, String(expression)]);
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

test("user_region_assignments migration supports active assignment history and primary region uniqueness", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "user_region_assignments"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "user_region_assignments" && entry[2] === "region_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "user_region_assignments" && entry[2] === "assignment_type"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "user_region_assignments" && entry[2] === "starts_at"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "user_region_assignments" && entry[2] === "ends_at"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "user_region_assignments" && entry[2] === "is_primary"));
  assert.ok(operations.some((entry) => entry[0] === "addCheckConstraint" && entry[2] === "user_region_assignments_effective_dates_check"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "user_region_assignments_active_assignment_index"));
  assert.ok(operations.some((entry) => entry[0] === "indexColumns" && entry[1] === "user_region_assignments_active_assignment_index"));
  assert.ok(operations.some((entry) => entry[0] === "indexUnique" && entry[1] === "user_region_assignments_active_assignment_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "user_region_assignments_active_primary_index"));
  assert.ok(operations.some((entry) => entry[0] === "indexWhere" && entry[1] === "user_region_assignments_active_primary_index"));
});

test("user_region_assignments migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "user_region_assignments_active_primary_index"],
      ["dropIndex", "user_region_assignments_active_assignment_index"],
      ["dropIndex", "user_region_assignments_region_id_index"],
      ["dropIndex", "user_region_assignments_user_id_index"],
      ["dropTable", "user_region_assignments"],
    ],
  );
});
