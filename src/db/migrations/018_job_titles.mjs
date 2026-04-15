import { sql } from "kysely";

/**
 * Concrete organizational titles linked to the abstract job level ladder.
 */

export async function up(db) {
  await db.schema
    .createTable("job_titles")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("job_level_id", "varchar(64)", (column) => column.notNull().references("job_levels.id").onDelete("cascade"))
    .addColumn("code", "varchar(120)", (column) => column.notNull())
    .addColumn("name", "varchar(255)", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("is_active", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("job_titles_job_level_id_index").on("job_titles").column("job_level_id").execute();
  await db.schema.createIndex("job_titles_code_index").on("job_titles").column("code").unique().execute();
  await db.schema.createIndex("job_titles_deleted_at_index").on("job_titles").column("deleted_at").execute();
}

export async function down(db) {
  await db.schema.dropIndex("job_titles_deleted_at_index").ifExists().execute();
  await db.schema.dropIndex("job_titles_code_index").ifExists().execute();
  await db.schema.dropIndex("job_titles_job_level_id_index").ifExists().execute();
  await db.schema.dropTable("job_titles").ifExists().execute();
}
