// Plugin loader AWCMS-Mini (ADR-018)
// loadAllPlugins() dipanggil saat app start untuk mendaftarkan semua plugin aktif.

import { registerPlugin, seedPluginPermissions } from "./registry.mjs";
import { getDatabase } from "../db/index.mjs";

/**
 * Daftar plugin yang aktif di AWCMS-Mini.
 * Tambahkan entry baru di sini setiap kali plugin baru dibuat.
 *
 * Format setiap entry:
 *   {
 *     getManifest: () => Promise<{ default?: object } | object>,  // import manifest JSON
 *     getModule:   () => Promise<object>,                          // import index.mjs plugin
 *   }
 *
 * Contoh (uncomment setelah plugin SIKESRA dari issue #311 siap):
 *   {
 *     getManifest: () => import("./sikesra/manifest.json", { with: { type: "json" } }),
 *     getModule:   () => import("./sikesra/index.mjs"),
 *   },
 */
const ACTIVE_PLUGINS = [
  // SIKESRA — Sistem Kesehatan Rakyat (ADR-016, issue #311)
  {
    getManifest: () => import("./sikesra/manifest.json", { with: { type: "json" } }),
    getModule: () => import("./sikesra/index.mjs"),
  },
  // SatuSehat Kobar — integrasi SatuSehat Kemenkes (ADR-016, issue #312)
  {
    getManifest: () => import("./satu-sehat-kobar/manifest.json", { with: { type: "json" } }),
    getModule: () => import("./satu-sehat-kobar/index.mjs"),
  },
];

/**
 * Muat dan daftarkan semua plugin aktif.
 * Panggil sekali saat server start, sebelum menerima request.
 *
 * Untuk setiap plugin:
 * 1. Import manifest dan module
 * 2. Daftarkan ke registry (validasi manifest)
 * 3. Seed permission ke DB (idempotent)
 * 4. Jalankan migration plugin jika pluginModule.migrate tersedia
 *
 * @param {{ db?: import("kysely").Kysely<unknown>; plugins?: Array<{ getManifest: Function; getModule: Function }> }} [options]
 *   plugins di-inject untuk testing; default = ACTIVE_PLUGINS.
 */
export async function loadAllPlugins({ db, plugins = ACTIVE_PLUGINS } = {}) {
  const database = db ?? getDatabase();

  for (const { getManifest, getModule } of plugins) {
    const manifestMod = await getManifest();
    const manifest = manifestMod.default ?? manifestMod;

    const pluginModule = await getModule();

    registerPlugin(manifest, pluginModule);
    await seedPluginPermissions(database, manifest);

    if (typeof pluginModule.migrate === "function") {
      await pluginModule.migrate(database);
    }
  }
}
