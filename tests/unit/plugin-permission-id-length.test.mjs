import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regresi: id permission plugin WAJIB muat di kolom permissions.id varchar(64).
// Bug ditemukan saat verifikasi deploy (Epik A2): id `plugin_perm_{module}_{code}`
// (module tertulis 2x) overflow untuk modul bernama panjang (satu_sehat_kobar).
// Fix: id ringkas `perm_{sanitized_code}` (code sudah unik karena memuat module).

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(__dirname, "../../src/plugins");

const MAX_ID_LEN = 64;

// Replikasi logika id di seedPluginPermissions (src/plugins/registry.mjs).
function pluginPermissionId(code) {
  return `perm_${code.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

test("plugin permission id: semua manifest menghasilkan id <= 64 char", () => {
  const offenders = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(pluginsDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const code of manifest.permissions ?? []) {
      const id = pluginPermissionId(code);
      if (id.length > MAX_ID_LEN) {
        offenders.push(`${entry.name}: "${id}" (${id.length} char)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `id permission plugin melebihi varchar(64):\n${offenders.join("\n")}`);
});

test("plugin permission id: kasus modul terpanjang (satu_sehat_kobar) tetap muat", () => {
  const id = pluginPermissionId("awcms:satu_sehat_kobar:patient:read");
  assert.ok(id.length <= MAX_ID_LEN, `id ${id} (${id.length}) harus <= ${MAX_ID_LEN}`);
  assert.equal(id, "perm_awcms_satu_sehat_kobar_patient_read");
});
