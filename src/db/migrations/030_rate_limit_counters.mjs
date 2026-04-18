import { sql } from "kysely";

/**
 * Shared TTL-backed counter state for auth throttling and temporary lockouts.
 */

export async function up(db) {
  await db.schema
    .createTable("rate_limit_counters")
    .addColumn("scope_key", "varchar(160)", (column) => column.primaryKey())
    .addColumn("counter", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("window_starts_at", "timestamptz", (column) => column.notNull())
    .addColumn("locked_until", "timestamptz")
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("rate_limit_counters_expires_at_index")
    .on("rate_limit_counters")
    .column("expires_at")
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("rate_limit_counters_expires_at_index").ifExists().execute();
  await db.schema.dropTable("rate_limit_counters").ifExists().execute();
}
