/**
 * Seam runtime plugin (decoupling EmDash, ADR-020 Fase 2).
 *
 * Membungkus `definePlugin` & `PluginRouteError` dari EmDash agar kode plugin
 * tidak mengimpor `emdash` langsung. Pada Fase 3 (#318), `definePlugin` diganti
 * registry/loader native dan `PluginRouteError` diganti tipe error native —
 * cukup menukar implementasi di balik seam ini.
 */

// eslint-disable-next-line no-restricted-imports -- satu-satunya tempat boleh impor emdash (seam)
export { definePlugin, PluginRouteError } from "emdash";
