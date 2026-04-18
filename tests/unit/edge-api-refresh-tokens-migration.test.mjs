import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/033_edge_api_refresh_tokens.mjs";

function createFakeSchemaRecorder() {
  const operations = [];

  const columnBuilder = {
    primaryKey() {
      return columnBuilder;
    },
    notNull() {
      return columnBuilder;
    },
    references(value) {
      operations.push(["references", value]);
      return columnBuilder;
    },
    onDelete(value) {
      operations.push(["onDelete", value]);
      return columnBuilder;
    },
    defaultTo(value) {
      operations.push(["defaultTo", String(value)]);
      return columnBuilder;
    },
  };

  const tableBuilder = {
    addColumn(name, type, callback) {
      operations.push(["addColumn", name, type]);
      callback?.(columnBuilder);
      return tableBuilder;
    },
    execute: async () => {
      operations.push(["createTableExecute"]);
    },
  };

  const indexBuilder = {
    on(table) {
      operations.push(["indexOn", table]);
      return indexBuilder;
    },
    column(name) {
      operations.push(["indexColumn", name]);
      return indexBuilder;
    },
    ifExists() {
      operations.push(["ifExists"]);
      return indexBuilder;
    },
    execute: async () => {
      operations.push(["indexExecute"]);
    },
  };

  return {
    operations,
    db: {
      schema: {
        createTable(name) {
          operations.push(["createTable", name]);
          return tableBuilder;
        },
        createIndex(name) {
          operations.push(["createIndex", name]);
          return indexBuilder;
        },
        dropIndex(name) {
          operations.push(["dropIndex", name]);
          return indexBuilder;
        },
        dropTable(name) {
          operations.push(["dropTable", name]);
          return indexBuilder;
        },
      },
    },
  };
}

test("edge api refresh token migration creates rotation metadata columns and indexes", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.deepEqual(operations.filter((entry) => entry[0] === "addColumn").map((entry) => entry[1]), [
    "id",
    "session_id",
    "user_id",
    "token_hash",
    "session_strength",
    "two_factor_satisfied",
    "expires_at",
    "used_at",
    "revoked_at",
    "replaced_by_token_id",
    "created_at",
  ]);
  assert.equal(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "edge_api_refresh_tokens_session_id_index"), true);
  assert.equal(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "edge_api_refresh_tokens_expires_at_index"), true);
});

test("edge api refresh token migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.equal(operations.some((entry) => entry[0] === "dropIndex" && entry[1] === "edge_api_refresh_tokens_session_id_index"), true);
  assert.equal(operations.some((entry) => entry[0] === "dropIndex" && entry[1] === "edge_api_refresh_tokens_expires_at_index"), true);
  assert.equal(operations.some((entry) => entry[0] === "dropTable" && entry[1] === "edge_api_refresh_tokens"), true);
});
