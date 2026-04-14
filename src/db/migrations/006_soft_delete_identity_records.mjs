import { sql } from "kysely";

/**
 * Adds soft delete support for mutable identity records.
 */

export async function up(db) {
  await db.schema
    .alterTable("users")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("deleted_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("delete_reason", "text")
    .execute();

  await db.schema.createIndex("users_deleted_at_index").on("users").column("deleted_at").execute();

  await db.schema.alterTable("users").dropConstraint("users_status_check").execute();

  await db.schema
    .alterTable("users")
    .addCheckConstraint(
      "users_status_check",
      sql`status in ('invited', 'active', 'disabled', 'locked', 'deleted')`,
    )
    .execute();

  await db.schema.alterTable("user_profiles").addColumn("deleted_at", "timestamptz").execute();
  await db.schema.createIndex("user_profiles_deleted_at_index").on("user_profiles").column("deleted_at").execute();
}

export async function down(db) {
  await db.schema.dropIndex("user_profiles_deleted_at_index").ifExists().execute();
  await db.schema.alterTable("user_profiles").dropColumn("deleted_at").execute();

  await db.schema.alterTable("users").dropConstraint("users_status_check").execute();

  await db.schema
    .alterTable("users")
    .addCheckConstraint(
      "users_status_check",
      sql`status in ('invited', 'active', 'disabled', 'locked')`,
    )
    .execute();

  await db.schema.dropIndex("users_deleted_at_index").ifExists().execute();
  await db.schema.alterTable("users").dropColumn("delete_reason").execute();
  await db.schema.alterTable("users").dropColumn("deleted_by_user_id").execute();
  await db.schema.alterTable("users").dropColumn("deleted_at").execute();
}
