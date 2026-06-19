// Data adapter untuk plugin AWCMS-Mini (ADR-018, ADR-015)
// Menyediakan: set konteks user per koneksi, RLS helper untuk migration, base repository factory.

import { sql } from "kysely";

import { getDatabase } from "./index.mjs";
import { withTransaction } from "./transactions.mjs";

/**
 * Set konteks user aktif di PostgreSQL untuk RLS policy plugin.
 * Memakai set_config dengan local=true → berlaku hanya untuk transaksi saat ini.
 *
 * PENTING: `local=true` di-discard di akhir transaksi/statement. Agar konteks ini
 * benar-benar diterapkan ke query RLS, set_config dan query-nya **WAJIB berada di
 * transaksi yang sama** (koneksi yang sama). Gunakan `withUserContext()` — jangan
 * panggil ini lalu query terpisah (koneksi pool bisa berbeda → konteks hilang).
 *
 * @param {import("kysely").Kysely<unknown>|import("kysely").Transaction<unknown>} executor
 * @param {string} userId - ID user yang sedang aktif (dari session/actor)
 */
export async function setPluginDbContext(executor, userId) {
  await sql`select set_config('app.current_user_id', ${userId ?? ""}, true)`.execute(executor);
}

/**
 * Jalankan `callback` di dalam **satu transaksi** yang konteks RLS-nya
 * (`app.current_user_id`) sudah di-set lebih dulu — sehingga set_config(local) dan
 * query callback berbagi koneksi yang sama dan RLS policy benar-benar diterapkan.
 *
 * Inilah cara yang benar menerapkan konteks RLS pada jalur request dengan connection
 * pool (ADR-013/015): konteks per-operasi via transaksi, bukan set_config standalone.
 *
 * @template T
 * @param {import("kysely").Kysely<unknown>} db
 * @param {string} userId
 * @param {(trx: import("kysely").Transaction<unknown>) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withUserContext(db, userId, callback) {
  return withTransaction(db, async (trx) => {
    await setPluginDbContext(trx, userId);
    return callback(trx);
  });
}

/**
 * Hasilkan array SQL string untuk mengaktifkan RLS + policy akses pada tabel plugin.
 * Dipanggil di dalam migrate.mjs plugin setelah createTable, bukan di runtime.
 *
 * Model akses (keputusan #353 — assignment/role-based):
 *   1. **Creator** — `created_by = app.current_user_id` (selalu).
 *   2. **Admin bypass** (opsional) — `app.is_admin = 'true'` (di-set middleware admin).
 *   3. **Region assignment** (opsional) — bila `regionColumn` diberikan, user yang
 *      punya **penugasan aktif** ke region baris (via `user_administrative_region_assignments`)
 *      boleh akses **lintas-creator**. NULL-safe: baris dengan region NULL hanya
 *      diakses creator/admin (tidak melebar).
 *
 * Akses lintas-creator pada data sensitif (highly_restricted: SIKESRA) **WAJIB
 * diaudit** + permission ketat di service layer (defense-in-depth) — lihat
 * `server/routes/api-v1-search.mjs` (onAudit).
 *
 * Idempotent: policy lama (`plugin_user_isolation`) & baru (`plugin_access`)
 * di-`drop ... if exists` sebelum dibuat ulang → aman dijalankan berkali-kali.
 *
 * @param {string} schema - Nama schema plugin (snake_case, contoh: "sikesra")
 * @param {string} tableName - Nama tabel (contoh: "subjects")
 * @param {{ regionColumn?: string, adminBypass?: boolean, createdByColumn?: string }} [options]
 * @returns {string[]} Array SQL string yang harus dieksekusi berurutan
 */
export function buildPluginRlsStatements(schema, tableName, options = {}) {
  const qualified = `${schema}.${tableName}`;
  const createdByColumn = options.createdByColumn ?? "created_by";
  const clauses = [
    `${qualified}.${createdByColumn} = current_setting('app.current_user_id', true)::text`,
  ];

  if (options.adminBypass) {
    clauses.push(`current_setting('app.is_admin', true) = 'true'`);
  }

  if (options.regionColumn) {
    // Lintas-creator HANYA bila region baris terisi DAN user punya penugasan aktif
    // ke region tsb. `ends_at is null` = penugasan masih berlaku (effective-dated).
    clauses.push(
      `(${qualified}.${options.regionColumn} is not null and exists (
         select 1 from public.user_administrative_region_assignments ura
         where ura.user_id = current_setting('app.current_user_id', true)
           and ura.administrative_region_id = ${qualified}.${options.regionColumn}
           and ura.ends_at is null
       ))`,
    );
  }

  return [
    `alter table ${qualified} enable row level security`,
    `alter table ${qualified} force row level security`,
    `drop policy if exists plugin_user_isolation on ${qualified}`,
    `drop policy if exists plugin_access on ${qualified}`,
    `create policy plugin_access on ${qualified}
       using (${clauses.join("\n         or ")})`,
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
