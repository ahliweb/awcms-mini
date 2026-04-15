import { sql } from "kysely";

/**
 * Logical operational region hierarchy using adjacency list plus materialized path.
 */

export async function up(db) {
  await db.schema
    .createTable("regions")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("code", "varchar(120)", (column) => column.notNull())
    .addColumn("name", "varchar(255)", (column) => column.notNull())
    .addColumn("parent_id", "varchar(64)", (column) => column.references("regions.id").onDelete("set null"))
    .addColumn("level", "integer", (column) => column.notNull())
    .addColumn("path", "text", (column) => column.notNull())
    .addColumn("sort_order", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("is_active", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("regions_level_min_check", sql`level >= 1`)
    .addCheckConstraint("regions_level_max_check", sql`level <= 10`)
    .execute();

  await db.schema.createIndex("regions_code_index").on("regions").column("code").unique().execute();
  await db.schema.createIndex("regions_parent_id_index").on("regions").column("parent_id").execute();
  await db.schema.createIndex("regions_path_index").on("regions").column("path").execute();
  await db.schema.createIndex("regions_level_index").on("regions").column("level").execute();
  await db.schema.createIndex("regions_deleted_at_index").on("regions").column("deleted_at").execute();
}

export async function down(db) {
  await db.schema.dropIndex("regions_deleted_at_index").ifExists().execute();
  await db.schema.dropIndex("regions_level_index").ifExists().execute();
  await db.schema.dropIndex("regions_path_index").ifExists().execute();
  await db.schema.dropIndex("regions_parent_id_index").ifExists().execute();
  await db.schema.dropIndex("regions_code_index").ifExists().execute();
  await db.schema.dropTable("regions").ifExists().execute();
}
