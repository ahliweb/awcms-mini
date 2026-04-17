import { sql } from "kysely";

/**
 * Append-only security incident and posture event stream.
 */

export async function up(db) {
  await db.schema
    .createTable("security_events")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("event_type", "varchar(80)", (column) => column.notNull())
    .addColumn("severity", "varchar(32)", (column) => column.notNull())
    .addColumn("details_json", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("ip_address", "varchar(64)")
    .addColumn("user_agent", "text")
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("security_events_user_id_index").on("security_events").column("user_id").execute();

  await db.schema
    .createIndex("security_events_event_type_occurred_at_index")
    .on("security_events")
    .columns(["event_type", "occurred_at"])
    .execute();

  await db.schema
    .createIndex("security_events_severity_occurred_at_index")
    .on("security_events")
    .columns(["severity", "occurred_at"])
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("security_events_severity_occurred_at_index").ifExists().execute();
  await db.schema.dropIndex("security_events_event_type_occurred_at_index").ifExists().execute();
  await db.schema.dropIndex("security_events_user_id_index").ifExists().execute();
  await db.schema.dropTable("security_events").ifExists().execute();
}
