import { sql } from "kysely";

/**
 * Effective-dated user assignments to logical operational regions.
 */

export async function up(db) {
  await db.schema
    .createTable("user_region_assignments")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull().references("users.id").onDelete("cascade"))
    .addColumn("region_id", "varchar(64)", (column) => column.notNull().references("regions.id").onDelete("cascade"))
    .addColumn("assignment_type", "varchar(80)", (column) => column.notNull().defaultTo("member"))
    .addColumn("is_primary", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("starts_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("ends_at", "timestamptz")
    .addColumn("assigned_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("user_region_assignments_effective_dates_check", sql`ends_at is null or ends_at > starts_at`)
    .execute();

  await db.schema.createIndex("user_region_assignments_user_id_index").on("user_region_assignments").column("user_id").execute();
  await db.schema.createIndex("user_region_assignments_region_id_index").on("user_region_assignments").column("region_id").execute();
  await db.schema
    .createIndex("user_region_assignments_active_assignment_index")
    .on("user_region_assignments")
    .columns(["user_id", "region_id", "assignment_type"])
    .unique()
    .where(sql`ends_at is null`)
    .execute();
  await db.schema
    .createIndex("user_region_assignments_active_primary_index")
    .on("user_region_assignments")
    .column("user_id")
    .unique()
    .where(sql`is_primary = true and ends_at is null`)
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("user_region_assignments_active_primary_index").ifExists().execute();
  await db.schema.dropIndex("user_region_assignments_active_assignment_index").ifExists().execute();
  await db.schema.dropIndex("user_region_assignments_region_id_index").ifExists().execute();
  await db.schema.dropIndex("user_region_assignments_user_id_index").ifExists().execute();
  await db.schema.dropTable("user_region_assignments").ifExists().execute();
}
