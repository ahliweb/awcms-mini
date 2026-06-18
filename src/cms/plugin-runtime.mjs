/**
 * Seam runtime plugin (decoupling EmDash, ADR-020).
 *
 * Sejak Fase 3 (#327), implementasi sudah **native**: `definePlugin`
 * (`./define-plugin.mjs`) dan `PluginRouteError` (`./plugin-route-error.mjs`) —
 * tidak lagi mengimpor `emdash`. Seam dipertahankan agar call-site plugin tetap
 * stabil bila implementasi di baliknya berubah lagi.
 */

export { definePlugin } from "./define-plugin.mjs";
export { PluginRouteError } from "./plugin-route-error.mjs";
