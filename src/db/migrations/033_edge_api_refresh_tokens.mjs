import { sql } from "kysely";

/**
 * Rotation-backed opaque refresh tokens for the `/api/v1/token` edge API.
 */

export async function up(db) {
  await db.schema
    .createTable("edge_api_refresh_tokens")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("session_id", "varchar(64)", (column) => column.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("user_id", "varchar(64)", (column) => column.notNull().references("users.id").onDelete("cascade"))
    .addColumn("token_hash", "text", (column) => column.notNull())
    .addColumn("session_strength", "varchar(32)", (column) => column.notNull())
    .addColumn("two_factor_satisfied", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("replaced_by_token_id", "varchar(64)", (column) => column.references("edge_api_refresh_tokens.id").onDelete("set null"))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("edge_api_refresh_tokens_session_id_index").on("edge_api_refresh_tokens").column("session_id").execute();
  await db.schema.createIndex("edge_api_refresh_tokens_user_id_index").on("edge_api_refresh_tokens").column("user_id").execute();
  await db.schema.createIndex("edge_api_refresh_tokens_expires_at_index").on("edge_api_refresh_tokens").column("expires_at").execute();
}

export async function down(db) {
  await db.schema.dropIndex("edge_api_refresh_tokens_expires_at_index").ifExists().execute();
  await db.schema.dropIndex("edge_api_refresh_tokens_user_id_index").ifExists().execute();
  await db.schema.dropIndex("edge_api_refresh_tokens_session_id_index").ifExists().execute();
  await db.schema.dropTable("edge_api_refresh_tokens").ifExists().execute();
}
