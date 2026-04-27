import { sql } from "kysely";

/**
 * Notification message templates.
 *
 * Stores reusable templates for email and WhatsApp notifications,
 * keyed by channel, provider, template_key, and language.
 */

export async function up(db) {
  await db.schema
    .createTable("message_templates")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("template_key", "varchar(120)", (column) => column.notNull())
    .addColumn("channel", "varchar(32)", (column) => column.notNull())
    .addColumn("provider", "varchar(64)", (column) => column.notNull())
    .addColumn("language", "varchar(16)", (column) =>
      column.notNull().defaultTo("en"),
    )
    .addColumn("subject", "text")
    .addColumn("body", "text", (column) => column.notNull())
    .addColumn("status", "varchar(32)", (column) =>
      column.notNull().defaultTo("active"),
    )
    .addColumn("metadata", "jsonb", (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_by", "varchar(64)")
    .addColumn("updated_by", "varchar(64)")
    .addColumn("deleted_by", "varchar(64)")
    .execute();

  await db.schema
    .createIndex("message_templates_key_channel_language_unique")
    .on("message_templates")
    .columns(["template_key", "channel", "language"])
    .unique()
    .where(sql`deleted_at is null`)
    .execute();

  await db.schema
    .createIndex("message_templates_channel_status_index")
    .on("message_templates")
    .columns(["channel", "status"])
    .execute();
}

export async function down(db) {
  await db.schema
    .dropIndex("message_templates_channel_status_index")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("message_templates_key_channel_language_unique")
    .ifExists()
    .execute();
  await db.schema.dropTable("message_templates").ifExists().execute();
}
