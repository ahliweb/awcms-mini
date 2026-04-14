import { sql } from "kysely";

/**
 * Canonical user identity table.
 *
 * This is intentionally limited to the base identity record. Related profile,
 * session, and governance tables land in follow-on migrations.
 */

export async function up(db) {
  await db.schema
    .createTable("users")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("email", "varchar(320)", (column) => column.notNull().unique())
    .addColumn("username", "varchar(64)")
    .addColumn("display_name", "varchar(255)")
    .addColumn("password_hash", "text")
    .addColumn("status", "varchar(32)", (column) => column.notNull().defaultTo("invited"))
    .addColumn("last_login_at", "timestamptz")
    .addColumn("must_reset_password", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("is_protected", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "users_status_check",
      sql`status in ('invited', 'active', 'disabled', 'locked')`,
    )
    .execute();

  await db.schema.createIndex("users_status_index").on("users").column("status").execute();

  await db.schema
    .createIndex("users_last_login_at_index")
    .on("users")
    .column("last_login_at")
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("users_last_login_at_index").ifExists().execute();
  await db.schema.dropIndex("users_status_index").ifExists().execute();
  await db.schema.dropTable("users").ifExists().execute();
}
