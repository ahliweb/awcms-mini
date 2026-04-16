import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/023_audit_logs.mjs";

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
      columns(columnNames) {
        operations.push(["indexColumns", name, [...columnNames]]);
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

test("audit_logs migration defines append-only payload columns and actor/entity references", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "audit_logs"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "audit_logs" && entry[2] === "actor_user_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "audit_logs" && entry[2] === "entity_type"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "audit_logs" && entry[2] === "entity_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "audit_logs" && entry[2] === "target_user_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "audit_logs" && entry[2] === "before_payload" && entry[3] === "jsonb"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "audit_logs" && entry[2] === "after_payload" && entry[3] === "jsonb"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "audit_logs" && entry[2] === "metadata" && entry[3] === "jsonb"));
  assert.ok(operations.some((entry) => entry[0] === "defaultTo" && entry[1] === "audit_logs" && entry[2] === "metadata"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "audit_logs_occurred_at_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "audit_logs_actor_user_id_occurred_at_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "audit_logs_entity_lookup_index"));
});

test("audit_logs migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "audit_logs_action_occurred_at_index"],
      ["dropIndex", "audit_logs_entity_lookup_index"],
      ["dropIndex", "audit_logs_target_user_id_occurred_at_index"],
      ["dropIndex", "audit_logs_actor_user_id_occurred_at_index"],
      ["dropIndex", "audit_logs_occurred_at_index"],
      ["dropTable", "audit_logs"],
    ],
  );
});
