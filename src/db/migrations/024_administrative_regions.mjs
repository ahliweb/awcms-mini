import { sql } from "kysely";

/**
 * Indonesian legal administrative hierarchy using adjacency list plus materialized path.
 */

export async function up(db) {
  await db.schema
    .createTable("administrative_regions")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("code", "varchar(120)", (column) => column.notNull())
    .addColumn("name", "varchar(255)", (column) => column.notNull())
    .addColumn("type", "varchar(32)", (column) => column.notNull())
    .addColumn("parent_id", "varchar(64)", (column) => column.references("administrative_regions.id").onDelete("set null"))
    .addColumn("path", "text", (column) => column.notNull())
    .addColumn("province_code", "varchar(16)")
    .addColumn("regency_code", "varchar(16)")
    .addColumn("district_code", "varchar(16)")
    .addColumn("village_code", "varchar(16)")
    .addColumn("is_active", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "administrative_regions_type_check",
      sql`type in ('province', 'regency_city', 'district', 'village')`,
    )
    .execute();

  await db.schema.createIndex("administrative_regions_code_index").on("administrative_regions").column("code").unique().execute();
  await db.schema.createIndex("administrative_regions_parent_id_index").on("administrative_regions").column("parent_id").execute();
  await db.schema.createIndex("administrative_regions_path_index").on("administrative_regions").column("path").execute();
  await db.schema.createIndex("administrative_regions_type_index").on("administrative_regions").column("type").execute();
  await db.schema.createIndex("administrative_regions_province_code_index").on("administrative_regions").column("province_code").execute();
  await db.schema.createIndex("administrative_regions_regency_code_index").on("administrative_regions").column("regency_code").execute();
  await db.schema.createIndex("administrative_regions_district_code_index").on("administrative_regions").column("district_code").execute();
  await db.schema.createIndex("administrative_regions_village_code_index").on("administrative_regions").column("village_code").execute();
}

export async function down(db) {
  await db.schema.dropIndex("administrative_regions_village_code_index").ifExists().execute();
  await db.schema.dropIndex("administrative_regions_district_code_index").ifExists().execute();
  await db.schema.dropIndex("administrative_regions_regency_code_index").ifExists().execute();
  await db.schema.dropIndex("administrative_regions_province_code_index").ifExists().execute();
  await db.schema.dropIndex("administrative_regions_type_index").ifExists().execute();
  await db.schema.dropIndex("administrative_regions_path_index").ifExists().execute();
  await db.schema.dropIndex("administrative_regions_parent_id_index").ifExists().execute();
  await db.schema.dropIndex("administrative_regions_code_index").ifExists().execute();
  await db.schema.dropTable("administrative_regions").ifExists().execute();
}
