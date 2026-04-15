import { sql } from "kysely";

/**
 * Historical user job assignments with supervisor and primary-job support.
 */

export async function up(db) {
  await db.schema
    .createTable("user_jobs")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull().references("users.id").onDelete("cascade"))
    .addColumn("job_level_id", "varchar(64)", (column) => column.notNull().references("job_levels.id").onDelete("restrict"))
    .addColumn("job_title_id", "varchar(64)", (column) => column.references("job_titles.id").onDelete("set null"))
    .addColumn("supervisor_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("employment_status", "varchar(80)", (column) => column.notNull().defaultTo("active"))
    .addColumn("starts_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("ends_at", "timestamptz")
    .addColumn("is_primary", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("assigned_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("notes", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("user_jobs_effective_dates_check", sql`ends_at is null or ends_at > starts_at`)
    .execute();

  await db.schema.createIndex("user_jobs_user_id_index").on("user_jobs").column("user_id").execute();
  await db.schema.createIndex("user_jobs_job_level_id_index").on("user_jobs").column("job_level_id").execute();
  await db.schema.createIndex("user_jobs_job_title_id_index").on("user_jobs").column("job_title_id").execute();
  await db.schema.createIndex("user_jobs_supervisor_user_id_index").on("user_jobs").column("supervisor_user_id").execute();
  await db.schema
    .createIndex("user_jobs_active_primary_index")
    .on("user_jobs")
    .column("user_id")
    .unique()
    .where(sql`is_primary = true and ends_at is null`)
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("user_jobs_active_primary_index").ifExists().execute();
  await db.schema.dropIndex("user_jobs_supervisor_user_id_index").ifExists().execute();
  await db.schema.dropIndex("user_jobs_job_title_id_index").ifExists().execute();
  await db.schema.dropIndex("user_jobs_job_level_id_index").ifExists().execute();
  await db.schema.dropIndex("user_jobs_user_id_index").ifExists().execute();
  await db.schema.dropTable("user_jobs").ifExists().execute();
}
