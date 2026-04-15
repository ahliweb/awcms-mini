import { sql } from "kysely";

/**
 * Organizational seniority ladder kept separate from RBAC roles.
 */

export async function up(db) {
  await db.schema
    .createTable("job_levels")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("code", "varchar(120)", (column) => column.notNull())
    .addColumn("name", "varchar(255)", (column) => column.notNull())
    .addColumn("rank_order", "integer", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("is_system", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("job_levels_rank_order_check", sql`rank_order >= 1`)
    .execute();

  await db.schema.createIndex("job_levels_code_index").on("job_levels").column("code").unique().execute();
  await db.schema.createIndex("job_levels_rank_order_index").on("job_levels").column("rank_order").unique().execute();
  await db.schema.createIndex("job_levels_deleted_at_index").on("job_levels").column("deleted_at").execute();
}

export async function down(db) {
  await db.schema.dropIndex("job_levels_deleted_at_index").ifExists().execute();
  await db.schema.dropIndex("job_levels_rank_order_index").ifExists().execute();
  await db.schema.dropIndex("job_levels_code_index").ifExists().execute();
  await db.schema.dropTable("job_levels").ifExists().execute();
}
