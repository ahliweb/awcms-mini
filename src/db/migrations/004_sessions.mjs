import { sql } from "kysely";

/**
 * Active and historical authenticated sessions.
 *
 * Session tokens are stored as hashes only. Revoked and expired sessions are
 * retained for auditability and security analysis.
 */

export async function up(db) {
  await db.schema
    .createTable("sessions")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) =>
      column.references("users.id").onDelete("cascade").notNull(),
    )
    .addColumn("session_token_hash", "varchar(255)", (column) => column.notNull().unique())
    .addColumn("ip_address", "varchar(64)")
    .addColumn("user_agent", "text")
    .addColumn("trusted_device", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("last_seen_at", "timestamptz")
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("sessions_user_id_index").on("sessions").column("user_id").execute();

  await db.schema
    .createIndex("sessions_expires_at_index")
    .on("sessions")
    .column("expires_at")
    .execute();

  await db.schema
    .createIndex("sessions_revoked_at_index")
    .on("sessions")
    .column("revoked_at")
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("sessions_revoked_at_index").ifExists().execute();
  await db.schema.dropIndex("sessions_expires_at_index").ifExists().execute();
  await db.schema.dropIndex("sessions_user_id_index").ifExists().execute();
  await db.schema.dropTable("sessions").ifExists().execute();
}
