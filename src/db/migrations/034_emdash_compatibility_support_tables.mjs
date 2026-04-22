import { sql } from "kysely";

import { buildEmdashCompatibilityLedger } from "./emdash-compatibility.mjs";

const TEXT_TIMESTAMP = sql`CURRENT_TIMESTAMP::text`;

async function createCoreContentSupportTables(db) {
  await db.schema
    .createTable("revisions")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("collection", "text", (column) => column.notNull())
    .addColumn("entry_id", "text", (column) => column.notNull())
    .addColumn("data", "text", (column) => column.notNull())
    .addColumn("author_id", "varchar(64)")
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema
    .createIndex("idx_revisions_entry")
    .ifNotExists()
    .on("revisions")
    .columns(["collection", "entry_id"])
    .execute();

  await db.schema
    .createTable("taxonomies")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("slug", "text", (column) => column.notNull())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("parent_id", "text")
    .addColumn("data", "text")
    .addUniqueConstraint("taxonomies_name_slug_unique", ["name", "slug"])
    .addForeignKeyConstraint("taxonomies_parent_fk", ["parent_id"], "taxonomies", ["id"], (constraint) =>
      constraint.onDelete("set null"),
    )
    .execute();

  await db.schema.createIndex("idx_taxonomies_name").ifNotExists().on("taxonomies").column("name").execute();

  await db.schema
    .createTable("content_taxonomies")
    .ifNotExists()
    .addColumn("collection", "text", (column) => column.notNull())
    .addColumn("entry_id", "text", (column) => column.notNull())
    .addColumn("taxonomy_id", "text", (column) => column.notNull())
    .addPrimaryKeyConstraint("content_taxonomies_pk", ["collection", "entry_id", "taxonomy_id"])
    .addForeignKeyConstraint(
      "content_taxonomies_taxonomy_fk",
      ["taxonomy_id"],
      "taxonomies",
      ["id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .execute();

  await db.schema
    .createTable("media")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("filename", "text", (column) => column.notNull())
    .addColumn("mime_type", "text", (column) => column.notNull())
    .addColumn("size", "integer")
    .addColumn("width", "integer")
    .addColumn("height", "integer")
    .addColumn("alt", "text")
    .addColumn("caption", "text")
    .addColumn("storage_key", "text", (column) => column.notNull())
    .addColumn("content_hash", "text")
    .addColumn("status", "text", (column) => column.notNull().defaultTo("ready"))
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addColumn("author_id", "varchar(64)")
    .execute();

  await db.schema.createIndex("idx_media_content_hash").ifNotExists().on("media").column("content_hash").execute();
  await db.schema.createIndex("idx_media_status").ifNotExists().on("media").column("status").execute();
}

async function addAuditLogCompatibilityColumns(db) {
  await db.schema
    .alterTable("audit_logs")
    .addColumn("actor_id", "varchar(64)")
    .addColumn("actor_ip", "varchar(64)")
    .addColumn("resource_type", "varchar(80)")
    .addColumn("resource_id", "varchar(64)")
    .addColumn("details", "text")
    .addColumn("status", "text")
    .addColumn("timestamp", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema.createIndex("idx_audit_actor").ifNotExists().on("audit_logs").column("actor_id").execute();
  await db.schema.createIndex("idx_audit_action").ifNotExists().on("audit_logs").column("action").execute();
  await db.schema.createIndex("idx_audit_timestamp").ifNotExists().on("audit_logs").column("timestamp").execute();
}

async function createPluginAndAdminSupportTables(db) {
  await db.schema
    .createTable("_plugin_storage")
    .ifNotExists()
    .addColumn("plugin_id", "text", (column) => column.notNull())
    .addColumn("collection", "text", (column) => column.notNull())
    .addColumn("id", "text", (column) => column.notNull())
    .addColumn("data", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addColumn("updated_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addPrimaryKeyConstraint("pk_plugin_storage", ["plugin_id", "collection", "id"])
    .execute();

  await db.schema
    .createIndex("idx_plugin_storage_list")
    .ifNotExists()
    .on("_plugin_storage")
    .columns(["plugin_id", "collection", "created_at"])
    .execute();

  await db.schema
    .createTable("_plugin_indexes")
    .ifNotExists()
    .addColumn("plugin_id", "text", (column) => column.notNull())
    .addColumn("collection", "text", (column) => column.notNull())
    .addColumn("index_name", "text", (column) => column.notNull())
    .addColumn("fields", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addPrimaryKeyConstraint("pk_plugin_indexes", ["plugin_id", "collection", "index_name"])
    .execute();

  await db.schema
    .createTable("_emdash_menus")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull().unique())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addColumn("updated_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema
    .createTable("_emdash_menu_items")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("menu_id", "text", (column) => column.notNull())
    .addColumn("parent_id", "text")
    .addColumn("sort_order", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("reference_collection", "text")
    .addColumn("reference_id", "text")
    .addColumn("custom_url", "text")
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("title_attr", "text")
    .addColumn("target", "text")
    .addColumn("css_classes", "text")
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addForeignKeyConstraint("menu_items_menu_fk", ["menu_id"], "_emdash_menus", ["id"], (constraint) =>
      constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint("menu_items_parent_fk", ["parent_id"], "_emdash_menu_items", ["id"], (constraint) =>
      constraint.onDelete("cascade"),
    )
    .execute();

  await db.schema
    .createIndex("idx_menu_items_menu")
    .ifNotExists()
    .on("_emdash_menu_items")
    .columns(["menu_id", "sort_order"])
    .execute();

  await db.schema.createIndex("idx_menu_items_parent").ifNotExists().on("_emdash_menu_items").column("parent_id").execute();

  await db.schema
    .createTable("_emdash_widget_areas")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull().unique())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("description", "text")
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema
    .createTable("_emdash_widgets")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("area_id", "text", (column) => column.notNull().references("_emdash_widget_areas.id").onDelete("cascade"))
    .addColumn("sort_order", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("title", "text")
    .addColumn("content", "text")
    .addColumn("menu_name", "text")
    .addColumn("component_id", "text")
    .addColumn("component_props", "text")
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema.createIndex("idx_widgets_area").ifNotExists().on("_emdash_widgets").columns(["area_id", "sort_order"]).execute();
}

async function createAuthSupportTables(db) {
  await db.schema
    .createTable("credentials")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull())
    .addColumn("public_key", "bytea", (column) => column.notNull())
    .addColumn("counter", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("device_type", "text", (column) => column.notNull())
    .addColumn("backed_up", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("transports", "text")
    .addColumn("name", "text")
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addColumn("last_used_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addForeignKeyConstraint("credentials_user_fk", ["user_id"], "users", ["id"], (constraint) =>
      constraint.onDelete("cascade"),
    )
    .execute();

  await db.schema.createIndex("idx_credentials_user").ifNotExists().on("credentials").column("user_id").execute();

  await db.schema
    .createTable("auth_tokens")
    .ifNotExists()
    .addColumn("hash", "text", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(64)")
    .addColumn("email", "text")
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("role", "integer")
    .addColumn("invited_by", "varchar(64)")
    .addColumn("expires_at", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addForeignKeyConstraint("auth_tokens_user_fk", ["user_id"], "users", ["id"], (constraint) =>
      constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint("auth_tokens_invited_by_fk", ["invited_by"], "users", ["id"], (constraint) =>
      constraint.onDelete("set null"),
    )
    .execute();

  await db.schema.createIndex("idx_auth_tokens_email").ifNotExists().on("auth_tokens").column("email").execute();

  await db.schema
    .createTable("oauth_accounts")
    .ifNotExists()
    .addColumn("provider", "text", (column) => column.notNull())
    .addColumn("provider_account_id", "text", (column) => column.notNull())
    .addColumn("user_id", "varchar(64)", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .addPrimaryKeyConstraint("oauth_accounts_pk", ["provider", "provider_account_id"])
    .addForeignKeyConstraint("oauth_accounts_user_fk", ["user_id"], "users", ["id"], (constraint) =>
      constraint.onDelete("cascade"),
    )
    .execute();

  await db.schema.createIndex("idx_oauth_accounts_user").ifNotExists().on("oauth_accounts").column("user_id").execute();

  await db.schema
    .createTable("allowed_domains")
    .ifNotExists()
    .addColumn("domain", "text", (column) => column.primaryKey())
    .addColumn("default_role", "integer", (column) => column.notNull().defaultTo(20))
    .addColumn("enabled", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema
    .createTable("auth_challenges")
    .ifNotExists()
    .addColumn("challenge", "text", (column) => column.primaryKey())
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("user_id", "varchar(64)")
    .addColumn("data", "text")
    .addColumn("expires_at", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.defaultTo(TEXT_TIMESTAMP))
    .execute();

  await db.schema
    .createIndex("idx_auth_challenges_expires")
    .ifNotExists()
    .on("auth_challenges")
    .column("expires_at")
    .execute();
}

async function seedCompatibilityLedgerWhenEmpty(db) {
  const appliedRows = await db.selectFrom("_emdash_migrations").select(["name"]).limit(1).execute();

  if (appliedRows.length > 0) {
    return;
  }

  await db.insertInto("_emdash_migrations").values(buildEmdashCompatibilityLedger()).execute();
}

export async function up(db) {
  await createCoreContentSupportTables(db);
  await addAuditLogCompatibilityColumns(db);
  await createPluginAndAdminSupportTables(db);
  await createAuthSupportTables(db);
  await seedCompatibilityLedgerWhenEmpty(db);
}

export async function down(db) {
  await db.schema.dropIndex("idx_auth_challenges_expires").ifExists().execute();
  await db.schema.dropTable("auth_challenges").ifExists().execute();
  await db.schema.dropTable("allowed_domains").ifExists().execute();
  await db.schema.dropIndex("idx_oauth_accounts_user").ifExists().execute();
  await db.schema.dropTable("oauth_accounts").ifExists().execute();
  await db.schema.dropIndex("idx_auth_tokens_email").ifExists().execute();
  await db.schema.dropTable("auth_tokens").ifExists().execute();
  await db.schema.dropIndex("idx_credentials_user").ifExists().execute();
  await db.schema.dropTable("credentials").ifExists().execute();
  await db.schema.dropIndex("idx_widgets_area").ifExists().execute();
  await db.schema.dropTable("_emdash_widgets").ifExists().execute();
  await db.schema.dropTable("_emdash_widget_areas").ifExists().execute();
  await db.schema.dropIndex("idx_menu_items_parent").ifExists().execute();
  await db.schema.dropIndex("idx_menu_items_menu").ifExists().execute();
  await db.schema.dropTable("_emdash_menu_items").ifExists().execute();
  await db.schema.dropTable("_emdash_menus").ifExists().execute();
  await db.schema.dropTable("_plugin_indexes").ifExists().execute();
  await db.schema.dropIndex("idx_plugin_storage_list").ifExists().execute();
  await db.schema.dropTable("_plugin_storage").ifExists().execute();
  await db.schema.dropIndex("idx_audit_timestamp").ifExists().execute();
  await db.schema.dropIndex("idx_audit_action").ifExists().execute();
  await db.schema.dropIndex("idx_audit_actor").ifExists().execute();
  await db.schema.alterTable("audit_logs").dropColumn("timestamp").execute();
  await db.schema.alterTable("audit_logs").dropColumn("status").execute();
  await db.schema.alterTable("audit_logs").dropColumn("details").execute();
  await db.schema.alterTable("audit_logs").dropColumn("resource_id").execute();
  await db.schema.alterTable("audit_logs").dropColumn("resource_type").execute();
  await db.schema.alterTable("audit_logs").dropColumn("actor_ip").execute();
  await db.schema.alterTable("audit_logs").dropColumn("actor_id").execute();
  await db.schema.dropIndex("idx_media_status").ifExists().execute();
  await db.schema.dropIndex("idx_media_content_hash").ifExists().execute();
  await db.schema.dropTable("media").ifExists().execute();
  await db.schema.dropTable("content_taxonomies").ifExists().execute();
  await db.schema.dropIndex("idx_taxonomies_name").ifExists().execute();
  await db.schema.dropTable("taxonomies").ifExists().execute();
  await db.schema.dropIndex("idx_revisions_entry").ifExists().execute();
  await db.schema.dropTable("revisions").ifExists().execute();
}
