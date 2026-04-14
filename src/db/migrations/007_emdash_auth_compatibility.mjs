import { sql } from "kysely";

/**
 * Adds the minimum auth-compatibility columns EmDash middleware expects.
 *
 * Mini remains the source of truth for identity/session persistence, but these
 * compatibility fields allow EmDash's session middleware and /auth/me route to
 * resolve the authenticated user correctly.
 */

export async function up(db) {
  await db.schema
    .alterTable("users")
    .addColumn("name", "varchar(255)")
    .addColumn("avatar_url", "text")
    .addColumn("role", "integer", (column) => column.notNull().defaultTo(10))
    .addColumn("email_verified", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("disabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("data", "text")
    .execute();

  await sql`
    update users
    set
      name = display_name,
      disabled = case when status in ('disabled', 'locked', 'deleted') then true else false end,
      email_verified = case when status = 'invited' then false else true end
  `.execute(db);

  await db.schema.createIndex("users_role_index").on("users").column("role").execute();
  await db.schema.createIndex("users_disabled_index").on("users").column("disabled").execute();
}

export async function down(db) {
  await db.schema.dropIndex("users_disabled_index").ifExists().execute();
  await db.schema.dropIndex("users_role_index").ifExists().execute();
  await db.schema.alterTable("users").dropColumn("data").execute();
  await db.schema.alterTable("users").dropColumn("disabled").execute();
  await db.schema.alterTable("users").dropColumn("email_verified").execute();
  await db.schema.alterTable("users").dropColumn("role").execute();
  await db.schema.alterTable("users").dropColumn("avatar_url").execute();
  await db.schema.alterTable("users").dropColumn("name").execute();
}
