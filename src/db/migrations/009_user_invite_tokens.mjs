import { sql } from "kysely";

/**
 * Tokenized activation records for invited users.
 */

export async function up(db) {
  await db.schema
    .createTable("user_invite_tokens")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull())
    .addColumn("token_hash", "text", (column) => column.notNull())
    .addColumn("created_by_user_id", "varchar(64)")
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("consumed_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint("user_invite_tokens_user_fk", ["user_id"], "users", ["id"], (constraint) =>
      constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "user_invite_tokens_created_by_fk",
      ["created_by_user_id"],
      "users",
      ["id"],
      (constraint) => constraint.onDelete("set null"),
    )
    .execute();

  await db.schema
    .createIndex("user_invite_tokens_user_id_index")
    .on("user_invite_tokens")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("user_invite_tokens_expires_at_index")
    .on("user_invite_tokens")
    .column("expires_at")
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("user_invite_tokens_expires_at_index").ifExists().execute();
  await db.schema.dropIndex("user_invite_tokens_user_id_index").ifExists().execute();
  await db.schema.dropTable("user_invite_tokens").ifExists().execute();
}
