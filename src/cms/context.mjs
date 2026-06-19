/**
 * Seam konteks request (decoupling EmDash, ADR-020).
 *
 * Sejak Fase 3, implementasi sudah **native** (`./request-context.mjs`,
 * AsyncLocalStorage) — tidak lagi mengimpor `emdash`. Seam dipertahankan agar
 * call-site (`src/auth/middleware-entry.mjs`) tetap stabil bila implementasi
 * di baliknya berubah lagi.
 */

export { runWithContext, getRequestContext } from "./request-context.mjs";
