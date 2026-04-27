import { sql } from "kysely";

/**
 * Notification request queue and delivery log tables.
 *
 * notification_requests  — one row per outbound notification dispatched
 * notification_delivery_logs — one row per delivery attempt (allows retries)
 * provider_webhook_events    — inbound delivery receipts from Mailketing / Starsender
 */

export async function up(db) {
  // ------------------------------------------------------------------
  // notification_requests
  // ------------------------------------------------------------------
  await db.schema
    .createTable("notification_requests")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("channel", "varchar(32)", (column) => column.notNull())
    .addColumn("provider", "varchar(64)", (column) => column.notNull())
    .addColumn("template_id", "varchar(64)", (column) =>
      column.references("message_templates.id").onDelete("set null"),
    )
    .addColumn("recipient_user_id", "varchar(64)", (column) =>
      column.references("users.id").onDelete("set null"),
    )
    .addColumn("recipient_address", "text", (column) => column.notNull())
    .addColumn("subject", "text")
    .addColumn("body_rendered", "text")
    .addColumn("status", "varchar(32)", (column) =>
      column.notNull().defaultTo("pending"),
    )
    .addColumn("idempotency_key", "varchar(255)")
    .addColumn("metadata", "jsonb", (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("scheduled_at", "timestamptz")
    .addColumn("sent_at", "timestamptz")
    .addColumn("failed_at", "timestamptz")
    .addColumn("failure_reason", "text")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("created_by", "varchar(64)")
    .execute();

  await db.schema
    .createIndex("notification_requests_status_created_at_index")
    .on("notification_requests")
    .columns(["status", "created_at"])
    .execute();

  await db.schema
    .createIndex("notification_requests_recipient_user_id_index")
    .on("notification_requests")
    .column("recipient_user_id")
    .execute();

  await db.schema
    .createIndex("notification_requests_idempotency_key_unique")
    .on("notification_requests")
    .column("idempotency_key")
    .unique()
    .where(sql`idempotency_key is not null`)
    .execute();

  // ------------------------------------------------------------------
  // notification_delivery_logs
  // ------------------------------------------------------------------
  await db.schema
    .createTable("notification_delivery_logs")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("notification_request_id", "varchar(64)", (column) =>
      column.notNull().references("notification_requests.id").onDelete("cascade"),
    )
    .addColumn("attempt_number", "integer", (column) =>
      column.notNull().defaultTo(1),
    )
    .addColumn("provider_message_id", "text")
    .addColumn("status", "varchar(32)", (column) => column.notNull())
    .addColumn("response_code", "integer")
    .addColumn("response_body", "text")
    .addColumn("attempted_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("notification_delivery_logs_request_id_index")
    .on("notification_delivery_logs")
    .column("notification_request_id")
    .execute();

  // ------------------------------------------------------------------
  // provider_webhook_events
  // ------------------------------------------------------------------
  await db.schema
    .createTable("provider_webhook_events")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("provider", "varchar(64)", (column) => column.notNull())
    .addColumn("event_type", "varchar(120)", (column) => column.notNull())
    .addColumn("provider_message_id", "text")
    .addColumn("raw_payload", "jsonb", (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("processed", "boolean", (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn("processed_at", "timestamptz")
    .addColumn("received_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("provider_webhook_events_provider_received_at_index")
    .on("provider_webhook_events")
    .columns(["provider", "received_at"])
    .execute();

  await db.schema
    .createIndex("provider_webhook_events_processed_index")
    .on("provider_webhook_events")
    .column("processed")
    .where(sql`processed = false`)
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("provider_webhook_events_processed_index").ifExists().execute();
  await db.schema.dropIndex("provider_webhook_events_provider_received_at_index").ifExists().execute();
  await db.schema.dropTable("provider_webhook_events").ifExists().execute();

  await db.schema.dropIndex("notification_delivery_logs_request_id_index").ifExists().execute();
  await db.schema.dropTable("notification_delivery_logs").ifExists().execute();

  await db.schema.dropIndex("notification_requests_idempotency_key_unique").ifExists().execute();
  await db.schema.dropIndex("notification_requests_recipient_user_id_index").ifExists().execute();
  await db.schema.dropIndex("notification_requests_status_created_at_index").ifExists().execute();
  await db.schema.dropTable("notification_requests").ifExists().execute();
}
