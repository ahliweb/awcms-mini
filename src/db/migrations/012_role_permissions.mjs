import { sql } from "kysely";

/**
 * Maps roles to explicit permissions.
 */

export async function up(db) {
  await db.schema
    .createTable("role_permissions")
    .addColumn("role_id", "varchar(64)", (column) => column.notNull().references("roles.id").onDelete("cascade"))
    .addColumn("permission_id", "varchar(64)", (column) => column.notNull().references("permissions.id").onDelete("cascade"))
    .addColumn("granted_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("granted_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("role_permissions_pkey", ["role_id", "permission_id"])
    .execute();

  await db.schema.createIndex("role_permissions_permission_id_index").on("role_permissions").column("permission_id").execute();
}

export async function down(db) {
  await db.schema.dropIndex("role_permissions_permission_id_index").ifExists().execute();
  await db.schema.dropTable("role_permissions").ifExists().execute();
}
