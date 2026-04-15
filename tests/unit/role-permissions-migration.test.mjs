import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/012_role_permissions.mjs";

function createFakeSchemaRecorder() {
  const operations = [];

  function createTableBuilder(table) {
    return {
      addColumn(name, type, callback) {
        operations.push(["addColumn", table, name, type]);
        if (callback) {
          const column = {
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
      addPrimaryKeyConstraint(name, columns) {
        operations.push(["addPrimaryKeyConstraint", table, name, columns]);
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

test("role_permissions migration defines composite uniqueness and grant metadata", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "role_permissions"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "role_permissions" && entry[2] === "granted_by_user_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "role_permissions" && entry[2] === "granted_at"));
  assert.ok(
    operations.some(
      (entry) =>
        entry[0] === "addPrimaryKeyConstraint" &&
        entry[1] === "role_permissions" &&
        entry[2] === "role_permissions_pkey" &&
        Array.isArray(entry[3]) &&
        entry[3].join(",") === "role_id,permission_id",
    ),
  );
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "role_permissions_permission_id_index"));
});

test("role_permissions migration down removes index and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "role_permissions_permission_id_index"],
      ["dropTable", "role_permissions"],
    ],
  );
});
