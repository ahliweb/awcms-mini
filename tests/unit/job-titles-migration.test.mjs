import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/018_job_titles.mjs";

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

test("job_titles migration links titles to levels and enforces unique code", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "job_titles"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "job_titles" && entry[2] === "job_level_id"));
  assert.ok(operations.some((entry) => entry[0] === "references" && entry[1] === "job_titles" && entry[2] === "job_level_id" && entry[3] === "job_levels.id"));
  assert.ok(operations.some((entry) => entry[0] === "onDelete" && entry[1] === "job_titles" && entry[2] === "job_level_id" && entry[3] === "cascade"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "job_titles" && entry[2] === "code"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "job_titles" && entry[2] === "deleted_at"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "job_titles_job_level_id_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "job_titles_code_index"));
  assert.ok(operations.some((entry) => entry[0] === "indexUnique" && entry[1] === "job_titles_code_index"));
});

test("job_titles migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "job_titles_deleted_at_index"],
      ["dropIndex", "job_titles_code_index"],
      ["dropIndex", "job_titles_job_level_id_index"],
      ["dropTable", "job_titles"],
    ],
  );
});
