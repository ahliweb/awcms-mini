import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/029_security_events.mjs";

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
        operations.push(["indexColumns", name, columnNames]);
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

test("security_events migration defines event type, severity, details, and optional user linkage", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "security_events"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "security_events" && entry[2] === "user_id"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "security_events" && entry[2] === "event_type"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "security_events" && entry[2] === "severity"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "security_events" && entry[2] === "details_json" && entry[3] === "jsonb"));
  assert.ok(operations.some((entry) => entry[0] === "addColumn" && entry[1] === "security_events" && entry[2] === "ip_address"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "security_events_user_id_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "security_events_event_type_occurred_at_index"));
  assert.ok(operations.some((entry) => entry[0] === "createIndex" && entry[1] === "security_events_severity_occurred_at_index"));
});

test("security_events migration down removes indexes and table", async () => {
  const { db, operations } = createFakeSchemaRecorder();

  await down(db);

  assert.deepEqual(
    operations.filter((entry) => ["dropIndex", "dropTable"].includes(entry[0])),
    [
      ["dropIndex", "security_events_severity_occurred_at_index"],
      ["dropIndex", "security_events_event_type_occurred_at_index"],
      ["dropIndex", "security_events_user_id_index"],
      ["dropTable", "security_events"],
    ],
  );
});
