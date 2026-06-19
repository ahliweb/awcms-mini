// Migration DDL schema SatuSehat Kobar (plugin AWCMS-Mini, ADR-015/016/018)
// MVP: pasien lokal + encounter + log sinkronisasi ke SatuSehat Kemenkes

import { sql } from "kysely";

import { buildPluginRlsStatements } from "../../db/plugin-adapter.mjs";

/**
 * @param {import("kysely").Kysely<unknown>} db
 */
export async function migrate(db) {
  await sql`create schema if not exists satu_sehat_kobar`.execute(db);

  // ─── satu_sehat_kobar.patients ────────────────────────────────────────────
  // Pemetaan pasien lokal ↔ ID SatuSehat Kemenkes (restricted)
  // NIK terenkripsi; IHS number dari SatuSehat API
  await db.schema
    .withSchema("satu_sehat_kobar")
    .createTable("patients")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("nik_enc", "text")
    .addColumn("ihs_number", "varchar(64)")
    .addColumn("full_name", "varchar(255)", (c) => c.notNull())
    .addColumn("birth_date", "date")
    .addColumn("gender", "varchar(10)")
    .addColumn("classification", "text", (c) => c.notNull().defaultTo("restricted"))
    .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("updated_by", "text")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("deleted_by", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .withSchema("satu_sehat_kobar")
    .createIndex("ssk_patients_created_by_idx")
    .ifNotExists()
    .on("patients")
    .column("created_by")
    .execute();

  await db.schema
    .withSchema("satu_sehat_kobar")
    .createIndex("ssk_patients_ihs_number_idx")
    .ifNotExists()
    .on("patients")
    .column("ihs_number")
    .execute();

  // Region scoping (#353): kolom region + index untuk akses berbasis penugasan.
  // NULL-safe — baris lama (region NULL) tetap hanya creator/admin.
  await sql`alter table satu_sehat_kobar.patients add column if not exists administrative_region_id varchar(64)`.execute(db);
  await sql`create index if not exists ssk_patients_admin_region_idx on satu_sehat_kobar.patients (administrative_region_id)`.execute(db);

  // Enable RLS — model assignment/role-based (#353): creator OR admin OR penugasan region aktif.
  for (const stmt of buildPluginRlsStatements("satu_sehat_kobar", "patients", {
    regionColumn: "administrative_region_id",
    adminBypass: true,
  })) {
    await sql.raw(stmt).execute(db);
  }

  // ─── satu_sehat_kobar.encounters ──────────────────────────────────────────
  // Kunjungan/pertemuan yang akan disinkronkan ke SatuSehat
  await db.schema
    .withSchema("satu_sehat_kobar")
    .createTable("encounters")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("patient_id", "uuid", (c) => c.notNull().references("satu_sehat_kobar.patients.id").onDelete("restrict"))
    .addColumn("encounter_date", "date", (c) => c.notNull())
    .addColumn("encounter_type", "varchar(64)", (c) => c.notNull())
    .addColumn("status", "varchar(32)", (c) => c.notNull().defaultTo("pending"))
    .addColumn("satusehat_id", "varchar(128)")
    .addColumn("classification", "text", (c) => c.notNull().defaultTo("restricted"))
    .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("updated_by", "text")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("deleted_by", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .withSchema("satu_sehat_kobar")
    .createIndex("ssk_encounters_patient_id_idx")
    .ifNotExists()
    .on("encounters")
    .column("patient_id")
    .execute();

  await db.schema
    .withSchema("satu_sehat_kobar")
    .createIndex("ssk_encounters_status_idx")
    .ifNotExists()
    .on("encounters")
    .column("status")
    .execute();

  for (const stmt of buildPluginRlsStatements("satu_sehat_kobar", "encounters")) {
    await sql.raw(stmt).execute(db);
  }

  // ─── satu_sehat_kobar.sync_logs ───────────────────────────────────────────
  // Log sinkronisasi ke API SatuSehat (internal, bukan restricted)
  await db.schema
    .withSchema("satu_sehat_kobar")
    .createTable("sync_logs")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("entity_type", "varchar(64)", (c) => c.notNull())
    .addColumn("entity_id", "uuid", (c) => c.notNull())
    .addColumn("direction", "varchar(16)", (c) => c.notNull())
    .addColumn("status", "varchar(32)", (c) => c.notNull())
    .addColumn("http_status", "integer")
    .addColumn("error_message", "text")
    .addColumn("classification", "text", (c) => c.notNull().defaultTo("internal"))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .withSchema("satu_sehat_kobar")
    .createIndex("ssk_sync_logs_entity_idx")
    .ifNotExists()
    .on("sync_logs")
    .columns(["entity_type", "entity_id"])
    .execute();

  for (const stmt of buildPluginRlsStatements("satu_sehat_kobar", "sync_logs")) {
    await sql.raw(stmt).execute(db);
  }
}
