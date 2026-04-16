import { sql } from "kysely";

/**
 * Hashed one-time recovery codes for 2FA fallback access.
 */

export async function up(db) {
  await db.schema
    .createTable("recovery_codes")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull().references("users.id").onDelete("cascade"))
    .addColumn("code_hash", "text", (column) => column.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("replaced_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("recovery_codes_user_id_index").on("recovery_codes").column("user_id").execute();

  await db.schema
    .createIndex("recovery_codes_unused_user_id_index")
    .on("recovery_codes")
    .column("user_id")
    .where(sql`used_at is null and replaced_at is null`)
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("recovery_codes_unused_user_id_index").ifExists().execute();
  await db.schema.dropIndex("recovery_codes_user_id_index").ifExists().execute();
  await db.schema.dropTable("recovery_codes").ifExists().execute();
}
