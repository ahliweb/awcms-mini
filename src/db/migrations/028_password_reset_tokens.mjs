import { sql } from "kysely";

/**
 * Hashed password reset tokens for self-service and admin-issued resets.
 */

export async function up(db) {
  await db.schema
    .createTable("password_reset_tokens")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull().references("users.id").onDelete("cascade"))
    .addColumn("token_hash", "text", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("issued_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("password_reset_tokens_user_id_index").on("password_reset_tokens").column("user_id").execute();
  await db.schema.createIndex("password_reset_tokens_expires_at_index").on("password_reset_tokens").column("expires_at").execute();
}

export async function down(db) {
  await db.schema.dropIndex("password_reset_tokens_expires_at_index").ifExists().execute();
  await db.schema.dropIndex("password_reset_tokens_user_id_index").ifExists().execute();
  await db.schema.dropTable("password_reset_tokens").ifExists().execute();
}
