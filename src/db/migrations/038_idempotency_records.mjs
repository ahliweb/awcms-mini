import { sql } from "kysely";

/**
 * Idempotency records for API mutations.
 *
 * Stores request fingerprints and cached response bodies so that
 * retried POST requests with the same Idempotency-Key header are
 * de-duplicated at the service layer without re-executing side effects.
 */

export async function up(db) {
  await db.schema
    .createTable("idempotency_records")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("idempotency_key", "varchar(255)", (column) => column.notNull())
    .addColumn("request_path", "text", (column) => column.notNull())
    .addColumn("request_method", "varchar(16)", (column) => column.notNull())
    .addColumn("user_id", "varchar(64)", (column) =>
      column.references("users.id").onDelete("cascade"),
    )
    .addColumn("response_status", "integer")
    .addColumn("response_body", "jsonb")
    .addColumn("locked_at", "timestamptz")
    .addColumn("completed_at", "timestamptz")
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Unique per user + key combination; anonymous requests scope to NULL user_id.
  await db.schema
    .createIndex("idempotency_records_key_user_unique")
    .on("idempotency_records")
    .columns(["idempotency_key", "user_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idempotency_records_expires_at_index")
    .on("idempotency_records")
    .column("expires_at")
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("idempotency_records_expires_at_index").ifExists().execute();
  await db.schema.dropIndex("idempotency_records_key_user_unique").ifExists().execute();
  await db.schema.dropTable("idempotency_records").ifExists().execute();
}
