import { sql } from "kysely";

/**
 * Permission catalog for RBAC assignments.
 */

export async function up(db) {
  await db.schema
    .createTable("permissions")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("code", "varchar(190)", (column) => column.notNull())
    .addColumn("domain", "varchar(120)", (column) => column.notNull())
    .addColumn("resource", "varchar(120)", (column) => column.notNull())
    .addColumn("action", "varchar(120)", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("is_protected", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "permissions_code_format_check",
      sql`code ~ '^[a-z0-9]+(\.[a-z0-9_]+){2}$'`,
    )
    .execute();

  await db.schema.createIndex("permissions_code_index").on("permissions").column("code").unique().execute();
  await db.schema.createIndex("permissions_domain_index").on("permissions").column("domain").execute();
}

export async function down(db) {
  await db.schema.dropIndex("permissions_domain_index").ifExists().execute();
  await db.schema.dropIndex("permissions_code_index").ifExists().execute();
  await db.schema.dropTable("permissions").ifExists().execute();
}
