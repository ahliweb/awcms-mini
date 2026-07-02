import { sql } from "kysely";

// Concurrency toolkit — pencegahan race condition PostgreSQL (#360).
//
// Modul ini menyediakan primitive yang dapat dipakai ulang di service layer:
// - deteksi kegagalan serialisasi/deadlock (SQLSTATE 40001 / 40P01),
// - transaksi SERIALIZABLE dengan retry (untuk invariant lintas-row/tabel),
// - advisory lock transaksional (untuk resource logis: numbering, provisioning),
// - guardedStatusTransition (safe status transition dengan expected current status).
//
// Pola atomic-update dan UPSERT (`ON CONFLICT`) tetap ditulis langsung di
// repository memakai query builder Kysely; panduan lengkap ada di
// `docs/security/database-concurrency.md`.

// PostgreSQL SQLSTATE untuk transient failure yang aman untuk di-retry.
export const SQLSTATE_SERIALIZATION_FAILURE = "40001";
export const SQLSTATE_DEADLOCK_DETECTED = "40P01";

const DEFAULT_SERIALIZABLE_RETRIES = 3;

function isControlledTransaction(executor) {
  return Boolean(
    executor &&
      typeof executor === "object" &&
      typeof executor.commit === "function" &&
      typeof executor.rollback === "function",
  );
}

/**
 * True bila error PostgreSQL merupakan kegagalan transient (serialization
 * failure atau deadlock) yang aman untuk di-retry dengan mengulang transaksi.
 * Menelusuri `error.code` dan `error.cause.code` karena driver `pg` kadang
 * membungkus error asli.
 */
export function isSerializationFailure(error) {
  const code = error?.code ?? error?.cause?.code;
  return code === SQLSTATE_SERIALIZATION_FAILURE || code === SQLSTATE_DEADLOCK_DETECTED;
}

/**
 * Membangun kunci advisory lock yang stabil dan deterministik dari namespace
 * logis + identifier. Dipetakan ke int64 oleh `hashtext()` di sisi PostgreSQL.
 *
 * @example buildAdvisoryLockKey("awcms-mini:numbering", `${year}:${docType}`)
 */
export function buildAdvisoryLockKey(namespace, id) {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("buildAdvisoryLockKey requires a non-empty namespace string");
  }

  if (id === undefined || id === null || id === "") {
    throw new Error("buildAdvisoryLockKey requires a non-empty id");
  }

  return `${namespace}:${id}`;
}

/**
 * Mengambil transaction-scoped advisory lock. Lock otomatis dilepas saat
 * transaksi commit/rollback, sehingga tidak ada risiko lock bocor.
 *
 * WAJIB dipanggil di dalam transaksi aktif — advisory *xact* lock tidak
 * bermakna di luar transaksi.
 */
export async function acquireAdvisoryXactLock(trx, key) {
  if (!isControlledTransaction(trx)) {
    throw new Error("acquireAdvisoryXactLock requires an active transaction executor");
  }

  if (typeof key !== "string" || key.length === 0) {
    throw new Error("acquireAdvisoryXactLock requires a non-empty key");
  }

  await sql`select pg_advisory_xact_lock(hashtext(${key}))`.execute(trx);
}

/**
 * Menjalankan `callback` setelah mengambil advisory lock transaksional untuk
 * `key`. Menserialkan proses paralel yang menyentuh resource logis yang sama
 * (mis. penomoran dokumen, provisioning domain/order) tanpa mengunci baris tabel.
 *
 * Harus dipanggil dari dalam transaksi (lihat `withTransaction`).
 */
export async function withAdvisoryXactLock(trx, key, callback) {
  await acquireAdvisoryXactLock(trx, key);
  return callback(trx);
}

/**
 * Menjalankan `callback` di dalam transaksi SERIALIZABLE, dengan retry otomatis
 * saat PostgreSQL mengembalikan serialization failure / deadlock (SQLSTATE
 * 40001 / 40P01). Pakai ini untuk aturan bisnis yang bergantung pada konsistensi
 * beberapa baris/tabel yang tidak dapat diekspresikan sebagai satu atomic update.
 *
 * @param {import("kysely").Kysely<any>} db instance database (bukan transaksi).
 * @param {(trx) => Promise<T>} callback dijalankan dengan controlled transaction.
 * @param {{ retries?: number, onRetry?: (info: { attempt: number, error: unknown }) => void | Promise<void> }} [options]
 * @returns {Promise<T>}
 */
export async function withSerializableRetry(db, callback, options = {}) {
  if (!db || typeof db.startTransaction !== "function") {
    throw new Error("withSerializableRetry requires a Kysely database instance");
  }

  const retries = options.retries ?? DEFAULT_SERIALIZABLE_RETRIES;
  const onRetry = options.onRetry;

  let attempt = 0;

  for (;;) {
    const trx = await db.startTransaction().setIsolationLevel("serializable").execute();

    try {
      const result = await callback(trx);
      await trx.commit().execute();
      return result;
    } catch (error) {
      await trx.rollback().execute();

      if (isSerializationFailure(error) && attempt < retries) {
        attempt += 1;
        if (onRetry) {
          await onRetry({ attempt, error });
        }
        continue;
      }

      throw error;
    }
  }
}
