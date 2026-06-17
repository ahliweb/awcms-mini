// Migration DDL schema SIKESRA (plugin AWCMS-Mini, ADR-015/016/018)
// Referensi: docs/concepts/awcms-mini-sikesra-mvp-schema.md

import { sql } from "kysely";

import { buildPluginRlsStatements } from "../../db/plugin-adapter.mjs";

/**
 * Jalankan migration schema SIKESRA.
 * Idempotent: semua CREATE memakai IF NOT EXISTS.
 *
 * @param {import("kysely").Kysely<unknown>} db
 */
export async function migrate(db) {
  // Buat schema terpisah untuk SIKESRA (isolasi dari schema utama)
  await sql`create schema if not exists sikesra`.execute(db);

  // ─── sikesra.subjects ─────────────────────────────────────────────────────
  // Data identitas + kesehatan dasar subjek (highly_restricted)
  // NIK TIDAK PERNAH disimpan plaintext — selalu nik_enc (terenkripsi di app layer)
  await db.schema
    .withSchema("sikesra")
    .createTable("subjects")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("nik_enc", "text")
    .addColumn("full_name", "varchar(255)", (c) => c.notNull())
    .addColumn("birth_date", "date")
    .addColumn("gender", "varchar(10)")
    .addColumn("classification", "text", (c) => c.notNull().defaultTo("highly_restricted"))
    .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("updated_by", "text")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("deleted_by", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .withSchema("sikesra")
    .createIndex("sikesra_subjects_created_by_idx")
    .ifNotExists()
    .on("subjects")
    .column("created_by")
    .execute();

  await db.schema
    .withSchema("sikesra")
    .createIndex("sikesra_subjects_deleted_at_idx")
    .ifNotExists()
    .on("subjects")
    .column("deleted_at")
    .execute();

  // Enable RLS pada sikesra.subjects
  for (const stmt of buildPluginRlsStatements("sikesra", "subjects")) {
    await sql.raw(stmt).execute(db);
  }

  // ─── sikesra.records ──────────────────────────────────────────────────────
  // Catatan medis/layanan per subjek (highly_restricted)
  await db.schema
    .withSchema("sikesra")
    .createTable("records")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("subject_id", "uuid", (c) => c.notNull().references("sikesra.subjects.id").onDelete("restrict"))
    .addColumn("record_type", "varchar(64)", (c) => c.notNull())
    .addColumn("record_date", "date", (c) => c.notNull())
    .addColumn("notes", "text")
    .addColumn("classification", "text", (c) => c.notNull().defaultTo("highly_restricted"))
    .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("updated_by", "text")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("deleted_by", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .withSchema("sikesra")
    .createIndex("sikesra_records_subject_id_idx")
    .ifNotExists()
    .on("records")
    .column("subject_id")
    .execute();

  await db.schema
    .withSchema("sikesra")
    .createIndex("sikesra_records_created_by_idx")
    .ifNotExists()
    .on("records")
    .column("created_by")
    .execute();

  for (const stmt of buildPluginRlsStatements("sikesra", "records")) {
    await sql.raw(stmt).execute(db);
  }

  // ─── sikesra.record_documents ─────────────────────────────────────────────
  // Metadata dokumen terlampir (file biner di R2, bukan di DB)
  await db.schema
    .withSchema("sikesra")
    .createTable("record_documents")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("record_id", "uuid", (c) => c.notNull().references("sikesra.records.id").onDelete("restrict"))
    .addColumn("filename", "varchar(512)", (c) => c.notNull())
    .addColumn("mime_type", "varchar(128)", (c) => c.notNull())
    .addColumn("size_bytes", "bigint")
    .addColumn("r2_key", "text", (c) => c.notNull())
    .addColumn("checksum_sha256", "text")
    .addColumn("classification", "text", (c) => c.notNull().defaultTo("highly_restricted"))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("deleted_at", "timestamptz")
    .addColumn("deleted_by", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .withSchema("sikesra")
    .createIndex("sikesra_record_documents_record_id_idx")
    .ifNotExists()
    .on("record_documents")
    .column("record_id")
    .execute();

  for (const stmt of buildPluginRlsStatements("sikesra", "record_documents")) {
    await sql.raw(stmt).execute(db);
  }
}
