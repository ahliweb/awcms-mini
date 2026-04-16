import { sql } from "kysely";

/**
 * Append-only operational audit trail for admin, governance, and security actions.
 */

export async function up(db) {
  await db.schema
    .createTable("audit_logs")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("actor_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("action", "varchar(120)", (column) => column.notNull())
    .addColumn("entity_type", "varchar(80)", (column) => column.notNull())
    .addColumn("entity_id", "varchar(64)")
    .addColumn("target_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("request_id", "varchar(120)")
    .addColumn("ip_address", "varchar(64)")
    .addColumn("user_agent", "text")
    .addColumn("summary", "text")
    .addColumn("before_payload", "jsonb")
    .addColumn("after_payload", "jsonb")
    .addColumn("metadata", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("audit_logs_occurred_at_index")
    .on("audit_logs")
    .column("occurred_at")
    .execute();

  await db.schema
    .createIndex("audit_logs_actor_user_id_occurred_at_index")
    .on("audit_logs")
    .columns(["actor_user_id", "occurred_at"])
    .execute();

  await db.schema
    .createIndex("audit_logs_target_user_id_occurred_at_index")
    .on("audit_logs")
    .columns(["target_user_id", "occurred_at"])
    .execute();

  await db.schema
    .createIndex("audit_logs_entity_lookup_index")
    .on("audit_logs")
    .columns(["entity_type", "entity_id", "occurred_at"])
    .execute();

  await db.schema
    .createIndex("audit_logs_action_occurred_at_index")
    .on("audit_logs")
    .columns(["action", "occurred_at"])
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("audit_logs_action_occurred_at_index").ifExists().execute();
  await db.schema.dropIndex("audit_logs_entity_lookup_index").ifExists().execute();
  await db.schema.dropIndex("audit_logs_target_user_id_occurred_at_index").ifExists().execute();
  await db.schema.dropIndex("audit_logs_actor_user_id_occurred_at_index").ifExists().execute();
  await db.schema.dropIndex("audit_logs_occurred_at_index").ifExists().execute();
  await db.schema.dropTable("audit_logs").ifExists().execute();
}
