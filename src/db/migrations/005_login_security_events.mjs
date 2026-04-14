import { sql } from "kysely";

/**
 * Append-only login and authentication attempt history.
 *
 * `user_id` is nullable because some events can occur before the system can
 * resolve or trust a concrete user identity.
 */

export async function up(db) {
  await db.schema
    .createTable("login_security_events")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("email_attempted", "varchar(320)")
    .addColumn("event_type", "varchar(64)", (column) => column.notNull())
    .addColumn("outcome", "varchar(32)", (column) => column.notNull())
    .addColumn("reason", "text")
    .addColumn("ip_address", "varchar(64)")
    .addColumn("user_agent", "text")
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("login_security_events_user_id_occurred_at_index")
    .on("login_security_events")
    .columns(["user_id", "occurred_at"])
    .execute();

  await db.schema
    .createIndex("login_security_events_email_attempted_index")
    .on("login_security_events")
    .column("email_attempted")
    .execute();

  await db.schema
    .createIndex("login_security_events_event_type_occurred_at_index")
    .on("login_security_events")
    .columns(["event_type", "occurred_at"])
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("login_security_events_event_type_occurred_at_index").ifExists().execute();
  await db.schema.dropIndex("login_security_events_email_attempted_index").ifExists().execute();
  await db.schema.dropIndex("login_security_events_user_id_occurred_at_index").ifExists().execute();
  await db.schema.dropTable("login_security_events").ifExists().execute();
}
