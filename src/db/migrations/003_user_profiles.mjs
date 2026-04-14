import { sql } from "kysely";

/**
 * Non-auth profile attributes for a user identity.
 *
 * The one-to-one relationship is enforced by using `user_id` as both the
 * primary key and foreign key to `users.id`.
 */

export async function up(db) {
  await db.schema
    .createTable("user_profiles")
    .addColumn("user_id", "varchar(64)", (column) =>
      column.primaryKey().references("users.id").onDelete("cascade").notNull(),
    )
    .addColumn("phone", "varchar(64)")
    .addColumn("avatar_media_id", "varchar(64)")
    .addColumn("timezone", "varchar(64)")
    .addColumn("locale", "varchar(32)")
    .addColumn("notes", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db) {
  await db.schema.dropTable("user_profiles").ifExists().execute();
}
