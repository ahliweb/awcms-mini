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
  // Plugin akan ditambahkan di sini setelah issue #311 (SIKESRA) dan #312 (SatuSehatKobar) selesai
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
 * @param {{ db?: import("kysely").Kysely<unknown> }} [options]
 */
export async function loadAllPlugins({ db } = {}) {
  const database = db ?? getDatabase();

  for (const { getManifest, getModule } of ACTIVE_PLUGINS) {
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
