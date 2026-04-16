import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/026_totp_credentials.mjs";

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

test("totp_credentials migration stores encrypted secrets and enforces one active credential per user", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "totp_credentials"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "totp_credentials" && entry[2] === "secret_encrypted" && entry[3] === "text"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "totp_credentials" && entry[2] === "issuer"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "totp_credentials" && entry[2] === "label"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "totp_credentials" && entry[2] === "verified_at"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "totp_credentials" && entry[2] === "disabled_at"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "totp_credentials_active_user_id_unique"));
  assert.ok(operations.some((entry) => entry[0] === "indexUnique" && entry[1] === "totp_credentials_active_user_id_unique"));
  assert.ok(operations.some((entry) => entry[0] === "indexWhere" && entry[1] === "totp_credentials_active_user_id_unique"));
});

test("totp_credentials migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "totp_credentials_active_user_id_unique"],
      ["dropIndex", "totp_credentials_user_id_index"],
      ["dropTable", "totp_credentials"],
    ],
  );
});
