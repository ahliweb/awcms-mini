// Data adapter untuk plugin AWCMS-Mini (ADR-018, ADR-015)
// Menyediakan: set konteks user per koneksi, RLS helper untuk migration, base repository factory.

import { sql } from "kysely";

import { getDatabase } from "./index.mjs";

/**
 * Set konteks user aktif di PostgreSQL untuk RLS policy plugin.
 * Wajib dipanggil setiap request (via Hono middleware) sebelum query plugin dijalankan.
 * Memakai set_config dengan local=true agar berlaku hanya untuk transaksi/request ini.
 *
 * @param {import("kysely").Kysely<unknown>} db
 * @param {string} userId - ID user yang sedang aktif (dari session)
 */
export async function setPluginDbContext(db, userId) {
  await sql`select set_config('app.current_user_id', ${userId ?? ""}, true)`.execute(db);
}

/**
 * Hasilkan array SQL string untuk mengaktifkan RLS + policy isolasi per user pada tabel plugin.
 * Dipanggil di dalam migrate.mjs plugin setelah createTable, bukan di runtime.
 *
 * Policy yang dibuat: user hanya bisa membaca/mengubah record yang created_by = user aktif.
 * Untuk data highly_restricted (contoh: SIKESRA), ini wajib diperkuat dengan permission check
 * di service layer (defense-in-depth).
 *
 * @param {string} schema - Nama schema plugin (snake_case, contoh: "sikesra")
 * @param {string} tableName - Nama tabel (contoh: "subjects")
 * @returns {string[]} Array SQL string yang harus dieksekusi berurutan
 */
export function buildPluginRlsStatements(schema, tableName) {
  const qualified = `${schema}.${tableName}`;

  return [
    `alter table ${qualified} enable row level security`,
    `alter table ${qualified} force row level security`,
    // Policy: user hanya bisa akses record yang dia buat (single-tenant, per-user isolation)
    `create policy plugin_user_isolation on ${qualified}
       using (created_by = current_setting('app.current_user_id', true)::text)`,
  ];
}

/**
 * Factory base repository untuk plugin — wraps Kysely dengan soft-delete guard otomatis.
 * Setiap method hanya mengembalikan record yang belum di-soft-delete (deleted_at IS NULL).
 *
 * Penggunaan:
 *   const subjectsRepo = createPluginRepository("sikesra", "subjects");
 *   const subjects = await subjectsRepo.findAll();
 *
 * @param {string} schema - Nama schema plugin (snake_case)
 * @param {string} tableName - Nama tabel
 */
export function createPluginRepository(schema, tableName) {
  function db() {
    return getDatabase().withSchema(schema);
  }

  return {
    /**
     * Cari record berdasarkan ID. Mengembalikan undefined jika tidak ditemukan atau sudah dihapus.
     */
    async findById(id) {
      return db()
        .selectFrom(tableName)
        .selectAll()
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
    },

    /**
     * Daftar semua record aktif (belum dihapus), dengan pagination.
     */
    async findAll({ limit = 50, offset = 0 } = {}) {
      return db()
        .selectFrom(tableName)
        .selectAll()
        .where("deleted_at", "is", null)
        .limit(limit)
        .offset(offset)
        .execute();
    },

    /**
     * Insert record baru. Otomatis mengisi created_at dan updated_at.
     * Kolom created_by harus diisi oleh caller (dari session user).
     */
    async insert(record) {
      return getDatabase()
        .withSchema(schema)
        .insertInto(tableName)
        .values({
          ...record,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    /**
     * Soft delete record — mengisi deleted_at dan deleted_by.
     * Mengembalikan undefined jika record tidak ditemukan atau sudah dihapus.
     */
    async softDelete(id, deletedBy) {
      return getDatabase()
        .withSchema(schema)
        .updateTable(tableName)
        .set({
          deleted_at: new Date(),
          deleted_by: deletedBy,
        })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .returningAll()
        .executeTakeFirst();
    },

    /**
     * Update field record. Otomatis mengisi updated_at.
     * Tidak bisa update record yang sudah dihapus.
     */
    async update(id, fields) {
      return getDatabase()
        .withSchema(schema)
        .updateTable(tableName)
        .set({
          ...fields,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .returningAll()
        .executeTakeFirst();
    },
  };
}
