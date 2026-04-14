import { sql } from "kysely";

/**
 * Role catalog and authority metadata.
 */

export async function up(db) {
  await db.schema
    .createTable("roles")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("slug", "varchar(120)", (column) => column.notNull())
    .addColumn("name", "varchar(255)", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("staff_level", "integer", (column) => column.notNull())
    .addColumn("is_system", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("is_assignable", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("is_protected", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("deleted_at", "timestamptz")
    .addColumn("deleted_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("delete_reason", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("roles_staff_level_check", sql`staff_level between 1 and 10`)
    .execute();

  await db.schema.createIndex("roles_slug_index").on("roles").column("slug").unique().execute();
  await db.schema.createIndex("roles_staff_level_index").on("roles").column("staff_level").execute();
  await db.schema.createIndex("roles_deleted_at_index").on("roles").column("deleted_at").execute();
}

export async function down(db) {
  await db.schema.dropIndex("roles_deleted_at_index").ifExists().execute();
  await db.schema.dropIndex("roles_staff_level_index").ifExists().execute();
  await db.schema.dropIndex("roles_slug_index").ifExists().execute();
  await db.schema.dropTable("roles").ifExists().execute();
}
