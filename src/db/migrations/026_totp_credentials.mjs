import { sql } from "kysely";

/**
 * Encrypted TOTP enrollment records.
 */

export async function up(db) {
  await db.schema
    .createTable("totp_credentials")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull().references("users.id").onDelete("cascade"))
    .addColumn("secret_encrypted", "text", (column) => column.notNull())
    .addColumn("issuer", "varchar(255)", (column) => column.notNull())
    .addColumn("label", "varchar(255)", (column) => column.notNull())
    .addColumn("verified_at", "timestamptz")
    .addColumn("last_used_at", "timestamptz")
    .addColumn("disabled_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("totp_credentials_user_id_index").on("totp_credentials").column("user_id").execute();

  await db.schema
    .createIndex("totp_credentials_active_user_id_unique")
    .on("totp_credentials")
    .column("user_id")
    .unique()
    .where(sql`disabled_at is null`)
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("totp_credentials_active_user_id_unique").ifExists().execute();
  await db.schema.dropIndex("totp_credentials_user_id_index").ifExists().execute();
  await db.schema.dropTable("totp_credentials").ifExists().execute();
}
