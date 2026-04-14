import { sql } from "kysely";

const TEXT_TIMESTAMP = sql`CURRENT_TIMESTAMP::text`;
const MIGRATION_LOCK_ID = "migration_lock";

/**
 * Bootstraps the EmDash support tables Mini relies on at runtime.
 *
 * Mini owns the canonical identity schema, so we intentionally do not replay
 * EmDash's auth migrations against `users`. Instead, we provide the core
 * support tables the EmDash admin/runtime expects on clean databases.
 */

export async function up(db) {
  await db.schema
    .createTable("options")
    .ifNotExists()
    .addColumn("name", "text", (column) => column.primaryKey())
    .addColumn("value", "text", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("_emdash_migrations")
    .ifNotExists()
    .addColumn("name", "varchar(255)", (column) => column.notNull().primaryKey())
    .addColumn("timestamp", "varchar(255)", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("_emdash_migrations_lock")
    .ifNotExists()
    .addColumn("id", "varchar(255)", (column) => column.notNull().primaryKey())
    .addColumn("is_locked", "integer", (column) => column.notNull().defaultTo(0))
    .execute();

  await db
    .insertInto("_emdash_migrations_lock")
    .values({
      id: MIGRATION_LOCK_ID,
      is_locked: 0,
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();

  await db.schema
    .createTable("_emdash_collections")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("slug", "text", (column) => column.notNull().unique())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("label_singular", "text")
    .addColumn("description", "text")
    .addColumn("icon", "text")
    .addColumn("supports", "text")
    .addColumn("source", "text")
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addColumn("updated_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema
    .createTable("_emdash_fields")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("collection_id", "text", (column) => column.notNull())
    .addColumn("slug", "text", (column) => column.notNull())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("column_type", "text", (column) => column.notNull())
    .addColumn("required", "integer", (column) => column.defaultTo(0))
    .addColumn("unique", "integer", (column) => column.defaultTo(0))
    .addColumn("default_value", "text")
    .addColumn("validation", "text")
    .addColumn("widget", "text")
    .addColumn("options", "text")
    .addColumn("sort_order", "integer", (column) => column.defaultTo(0))
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addForeignKeyConstraint(
      "fields_collection_fk",
      ["collection_id"],
      "_emdash_collections",
      ["id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .execute();

  await db.schema
    .createIndex("idx_fields_collection_slug")
    .ifNotExists()
    .on("_emdash_fields")
    .columns(["collection_id", "slug"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_fields_collection")
    .ifNotExists()
    .on("_emdash_fields")
    .column("collection_id")
    .execute();

  await db.schema
    .createIndex("idx_fields_sort")
    .ifNotExists()
    .on("_emdash_fields")
    .columns(["collection_id", "sort_order"])
    .execute();

  await db.schema
    .createTable("_emdash_taxonomy_defs")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull().unique())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("label_singular", "text")
    .addColumn("hierarchical", "integer", (column) => column.defaultTo(0))
    .addColumn("collections", "text")
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db
    .insertInto("_emdash_taxonomy_defs")
    .values([
      {
        id: "taxdef_category",
        name: "category",
        label: "Categories",
        label_singular: "Category",
        hierarchical: 1,
        collections: JSON.stringify(["posts"]),
      },
      {
        id: "taxdef_tag",
        name: "tag",
        label: "Tags",
        label_singular: "Tag",
        hierarchical: 0,
        collections: JSON.stringify(["posts"]),
      },
    ])
    .onConflict((conflict) => conflict.column("name").doNothing())
    .execute();

  await db.schema
    .createTable("_plugin_state")
    .ifNotExists()
    .addColumn("plugin_id", "text", (column) => column.primaryKey())
    .addColumn("version", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull().defaultTo("installed"))
    .addColumn("installed_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addColumn("activated_at", "text")
    .addColumn("deactivated_at", "text")
    .addColumn("data", "text")
    .execute();

  await db.schema
    .createTable("_emdash_cron_tasks")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("plugin_id", "text", (column) => column.notNull())
    .addColumn("task_name", "text", (column) => column.notNull())
    .addColumn("schedule", "text", (column) => column.notNull())
    .addColumn("is_oneshot", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("data", "text")
    .addColumn("next_run_at", "text", (column) => column.notNull())
    .addColumn("last_run_at", "text")
    .addColumn("status", "text", (column) => column.notNull().defaultTo("idle"))
    .addColumn("locked_at", "text")
    .addColumn("enabled", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addUniqueConstraint("uq_cron_tasks_plugin_task", ["plugin_id", "task_name"])
    .execute();

  await db.schema
    .createIndex("idx_cron_tasks_due")
    .ifNotExists()
    .on("_emdash_cron_tasks")
    .columns(["enabled", "status", "next_run_at"])
    .execute();

  await db.schema
    .createIndex("idx_cron_tasks_plugin")
    .ifNotExists()
    .on("_emdash_cron_tasks")
    .column("plugin_id")
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("idx_cron_tasks_plugin").ifExists().execute();
  await db.schema.dropIndex("idx_cron_tasks_due").ifExists().execute();
  await db.schema.dropTable("_emdash_cron_tasks").ifExists().execute();
  await db.schema.dropTable("_plugin_state").ifExists().execute();
  await db.schema.dropTable("_emdash_taxonomy_defs").ifExists().execute();
  await db.schema.dropIndex("idx_fields_sort").ifExists().execute();
  await db.schema.dropIndex("idx_fields_collection").ifExists().execute();
  await db.schema.dropIndex("idx_fields_collection_slug").ifExists().execute();
  await db.schema.dropTable("_emdash_fields").ifExists().execute();
  await db.schema.dropTable("_emdash_collections").ifExists().execute();
  await db.schema.dropTable("_emdash_migrations_lock").ifExists().execute();
  await db.schema.dropTable("_emdash_migrations").ifExists().execute();
  await db.schema.dropTable("options").ifExists().execute();
}
