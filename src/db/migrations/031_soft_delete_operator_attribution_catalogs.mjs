export async function up(db) {
  await db.schema
    .alterTable("job_levels")
    .addColumn("deleted_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("delete_reason", "text")
    .execute();

  await db.schema
    .alterTable("job_titles")
    .addColumn("deleted_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("delete_reason", "text")
    .execute();

  await db.schema
    .alterTable("regions")
    .addColumn("deleted_by_user_id", "varchar(64)", (column) => column.references("users.id").onDelete("set null"))
    .addColumn("delete_reason", "text")
    .execute();
}

export async function down(db) {
  await db.schema.alterTable("regions").dropColumn("delete_reason").execute();
  await db.schema.alterTable("regions").dropColumn("deleted_by_user_id").execute();

  await db.schema.alterTable("job_titles").dropColumn("delete_reason").execute();
  await db.schema.alterTable("job_titles").dropColumn("deleted_by_user_id").execute();

  await db.schema.alterTable("job_levels").dropColumn("delete_reason").execute();
  await db.schema.alterTable("job_levels").dropColumn("deleted_by_user_id").execute();
}
