import test from "node:test";
import assert from "node:assert/strict";

import { down, up } from "../../src/db/migrations/034_emdash_compatibility_support_tables.mjs";

function createSchemaRecorder() {
  const operations = [];

  const columnBuilder = {
    primaryKey() {
      operations.push(["primaryKey"]);
      return columnBuilder;
    },
    notNull() {
      operations.push(["notNull"]);
      return columnBuilder;
    },
    unique() {
      operations.push(["unique"]);
      return columnBuilder;
    },
    defaultTo(value) {
      operations.push(["defaultTo", String(value)]);
      return columnBuilder;
    },
    references(reference) {
      operations.push(["references", reference]);
      return columnBuilder;
    },
    onDelete(value) {
      operations.push(["onDelete", value]);
      return columnBuilder;
    },
  };

  function createTableBuilder(table) {
    return {
      ifNotExists() {
        operations.push(["ifNotExists", table]);
        return this;
      },
      addColumn(name, type, callback) {
        operations.push(["addColumn", table, name, type]);
        callback?.(columnBuilder);
        return this;
      },
      addUniqueConstraint(name, columns) {
        operations.push(["addUniqueConstraint", table, name, [...columns]]);
        return this;
      },
      addPrimaryKeyConstraint(name, columns) {
        operations.push(["addPrimaryKeyConstraint", table, name, [...columns]]);
        return this;
      },
      addForeignKeyConstraint(name, columns, foreignTable, foreignColumns, callback) {
        operations.push(["addForeignKeyConstraint", table, name, [...columns], foreignTable, [...foreignColumns]]);
        const constraint = {
          onDelete(value) {
            operations.push(["foreignKeyOnDelete", table, name, value]);
            return constraint;
          },
        };
        callback?.(constraint);
        return this;
      },
      execute: async () => {
        operations.push(["createTableExecute", table]);
      },
    };
  }

  function createIndexBuilder(name) {
    return {
      ifNotExists() {
        operations.push(["indexIfNotExists", name]);
        return this;
      },
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
        operations.push(["indexExecute", name]);
      },
    };
  }

  function dropBuilder(name, kind) {
    return {
      ifExists() {
        operations.push([`${kind}IfExists`, name]);
        return this;
      },
      execute: async () => {
        operations.push([`${kind}Execute`, name]);
      },
    };
  }

  function alterTableBuilder(table) {
    return {
      addColumn(name, type, callback) {
        operations.push(["alterAddColumn", table, name, type]);
        callback?.(columnBuilder);
        return this;
      },
      dropColumn(name) {
        operations.push(["alterDropColumn", table, name]);
        return this;
      },
      execute: async () => {
        operations.push(["alterTableExecute", table]);
      },
    };
  }

  const db = {
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
        return dropBuilder(name, "dropIndex");
      },
      dropTable(table) {
        operations.push(["dropTable", table]);
        return dropBuilder(table, "dropTable");
      },
      alterTable(table) {
        operations.push(["alterTable", table]);
        return alterTableBuilder(table);
      },
    },
    selectFrom(table) {
      operations.push(["selectFrom", table]);
      return {
        select(columns) {
          operations.push(["select", table, [...columns]]);
          return this;
        },
        limit(value) {
          operations.push(["limit", table, value]);
          return this;
        },
        async execute() {
          operations.push(["selectExecute", table]);
          return [];
        },
      };
    },
    insertInto(table) {
      operations.push(["insertInto", table]);
      return {
        values(values) {
          operations.push(["insertValues", table, values]);
          return {
            async execute() {
              operations.push(["insertExecute", table]);
            },
          };
        },
      };
    },
    executeQuery(query) {
      operations.push(["executeQuery", String(query?.sql ?? "")]);
      return Promise.resolve({ rows: [] });
    },
  };

  return { db, operations };
}

test("emdash compatibility support migration bootstraps missing upstream support tables and ledger rows", async () => {
  const { db, operations } = createSchemaRecorder();

  await up(db);

  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "revisions"));
  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "media"));
  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "_plugin_storage"));
  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "_emdash_menus"));
  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "_emdash_widget_areas"));
  assert.ok(operations.some((entry) => entry[0] === "createTable" && entry[1] === "credentials"));
  assert.ok(operations.some((entry) => entry[0] === "alterAddColumn" && entry[1] === "audit_logs" && entry[2] === "actor_id"));
  assert.ok(operations.some((entry) => entry[0] === "insertInto" && entry[1] === "_emdash_migrations"));
});

test("emdash compatibility support migration down removes the compatibility support tables and columns", async () => {
  const { db, operations } = createSchemaRecorder();

  await down(db);

  assert.ok(operations.some((entry) => entry[0] === "dropTable" && entry[1] === "auth_challenges"));
  assert.ok(operations.some((entry) => entry[0] === "dropTable" && entry[1] === "credentials"));
  assert.ok(operations.some((entry) => entry[0] === "dropTable" && entry[1] === "_emdash_widgets"));
  assert.ok(operations.some((entry) => entry[0] === "dropTable" && entry[1] === "_plugin_storage"));
  assert.ok(operations.some((entry) => entry[0] === "alterDropColumn" && entry[1] === "audit_logs" && entry[2] === "actor_id"));
});
