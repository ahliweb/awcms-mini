/**
 * Seam konteks request (decoupling EmDash, ADR-020 Fase 2).
 *
 * Membungkus `runWithContext` dari EmDash agar kode app tidak mengimpor `emdash`
 * langsung. Saat helper konteks native siap (AsyncLocalStorage), implementasi di
 * balik seam ini ditukar tanpa mengubah call-site.
 */

// eslint-disable-next-line no-restricted-imports -- satu-satunya tempat boleh impor emdash (seam)
export { runWithContext } from "emdash";
