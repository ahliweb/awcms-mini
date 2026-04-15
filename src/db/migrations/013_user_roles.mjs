import { sql } from "kysely";

/**
 * Effective-dated user role assignments.
 */

export async function up(db) {
  await db.schema
    .createTable("user_roles")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull().references("users.id").onDelete("cascade"))
    .addColumn("role_id", "varchar(64)", (column) => column.notNull().references("roles.id").onDelete("cascade"))
    .addColumn("assigned_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("assigned_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz")
    .addColumn("is_primary", "boolean", (column) => column.notNull().defaultTo(false))
    .execute();

  await db.schema.createIndex("user_roles_user_id_index").on("user_roles").column("user_id").execute();
  await db.schema.createIndex("user_roles_role_id_index").on("user_roles").column("role_id").execute();
  await db.schema
    .createIndex("user_roles_active_assignment_index")
    .on("user_roles")
    .columns(["user_id", "role_id"])
    .unique()
    .where(sql`expires_at is null`)
    .execute();
  await db.schema
    .createIndex("user_roles_active_primary_index")
    .on("user_roles")
    .column("user_id")
    .unique()
    .where(sql`is_primary = true and expires_at is null`)
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("user_roles_active_primary_index").ifExists().execute();
  await db.schema.dropIndex("user_roles_active_assignment_index").ifExists().execute();
  await db.schema.dropIndex("user_roles_role_id_index").ifExists().execute();
  await db.schema.dropIndex("user_roles_user_id_index").ifExists().execute();
  await db.schema.dropTable("user_roles").ifExists().execute();
}
