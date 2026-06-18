/**
 * Konteks request native (decoupling EmDash, ADR-020 Fase 3).
 *
 * Pengganti `runWithContext`/`getRequestContext` dari paket `emdash`. Memakai
 * `AsyncLocalStorage` agar state ber-scope request tersedia tanpa propagasi
 * parameter eksplisit. Instance ALS disimpan di `globalThis` dengan kunci Symbol
 * agar tetap singleton walau bundler menduplikasi modul antar code-split chunk.
 *
 * Tidak ada dependency `emdash`; ini implementasi milik AWCMS-Mini sendiri.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const ALS_KEY = Symbol.for("awcms:request-context");

const storage =
  globalThis[ALS_KEY] ??
  (() => {
    const als = new AsyncLocalStorage();
    globalThis[ALS_KEY] = als;
    return als;
  })();

/**
 * Jalankan fungsi di dalam konteks request. Dipanggil middleware untuk
 * membungkus `next()` sehingga konteks tersedia ke seluruh kode hilir.
 *
 * @template T
 * @param {unknown} ctx konteks request
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithContext(ctx, fn) {
  return storage.run(ctx, fn);
}

/**
 * Ambil konteks request saat ini. Mengembalikan `undefined` bila tidak ada
 * konteks (fast path pengguna anonim).
 */
export function getRequestContext() {
  return storage.getStore();
}
