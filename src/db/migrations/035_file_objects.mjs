import { sql } from "kysely";

/**
 * File object metadata table.
 *
 * Stores metadata for files uploaded to Cloudflare R2.
 * Raw file content is never stored in PostgreSQL — only metadata.
 */

export async function up(db) {
  await db.schema
    .createTable("file_objects")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("entity_type", "varchar(80)")
    .addColumn("entity_id", "varchar(64)")
    .addColumn("bucket_name", "varchar(255)", (column) => column.notNull())
    .addColumn("storage_key", "text", (column) => column.notNull())
    .addColumn("original_name", "text", (column) => column.notNull())
    .addColumn("safe_name", "text", (column) => column.notNull())
    .addColumn("mime_type", "varchar(255)", (column) => column.notNull())
    .addColumn("extension", "varchar(32)")
    .addColumn("size_bytes", "bigint", (column) => column.notNull())
    .addColumn("checksum_sha256", "varchar(64)")
    .addColumn("visibility", "varchar(32)", (column) =>
      column.notNull().defaultTo("private"),
    )
    .addColumn("access_policy", "varchar(80)", (column) =>
      column.notNull().defaultTo("authenticated"),
    )
    .addColumn("uploaded_by", "varchar(64)", (column) =>
      column.references("users.id").onDelete("set null"),
    )
    .addColumn("uploaded_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("verified_at", "timestamptz")
    .addColumn("status", "varchar(32)", (column) =>
      column.notNull().defaultTo("pending"),
    )
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_by", "varchar(64)")
    .addColumn("updated_by", "varchar(64)")
    .addColumn("deleted_by", "varchar(64)")
    .execute();

  await db.schema
    .createIndex("file_objects_entity_lookup_index")
    .on("file_objects")
    .columns(["entity_type", "entity_id"])
    .execute();

  await db.schema
    .createIndex("file_objects_uploaded_by_index")
    .on("file_objects")
    .column("uploaded_by")
    .execute();

  await db.schema
    .createIndex("file_objects_status_index")
    .on("file_objects")
    .column("status")
    .execute();

  await db.schema
    .createIndex("file_objects_storage_key_unique")
    .on("file_objects")
    .column("storage_key")
    .unique()
    .execute();
}

export async function down(db) {
  await db.schema.dropIndex("file_objects_storage_key_unique").ifExists().execute();
  await db.schema.dropIndex("file_objects_status_index").ifExists().execute();
  await db.schema.dropIndex("file_objects_uploaded_by_index").ifExists().execute();
  await db.schema.dropIndex("file_objects_entity_lookup_index").ifExists().execute();
  await db.schema.dropTable("file_objects").ifExists().execute();
}
