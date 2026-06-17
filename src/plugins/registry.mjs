// Plugin registry AWCMS-Mini (ADR-018)
// Menyimpan plugin yang terdaftar; men-seed permission ke DB; menyediakan lookup.

import { assertValidPluginManifest } from "./manifest.mjs";
import { collectRegisteredPluginPermissions } from "./permission-registration.mjs";
import { createPermissionRepository } from "../db/repositories/permissions.mjs";

/** @type {Map<string, { manifest: object; module: object }>} */
const _registry = new Map();

/**
 * Daftarkan plugin ke registry.
 * Manifest divalidasi sebelum disimpan — melempar Error jika tidak valid atau duplikat.
 *
 * @param {object} manifest - Manifest plugin (harus lolos validatePluginManifest)
 * @param {object} pluginModule - Module plugin (object yang diekspor dari index.mjs plugin)
 */
export function registerPlugin(manifest, pluginModule) {
  assertValidPluginManifest(manifest);

  if (_registry.has(manifest.id)) {
    throw new Error(`Plugin "${manifest.id}" sudah terdaftar. Pastikan setiap plugin hanya di-register sekali.`);
  }

  _registry.set(manifest.id, { manifest, module: pluginModule });
}

/**
 * Ambil entry plugin dari registry berdasarkan ID.
 * Mengembalikan undefined jika tidak ditemukan.
 *
 * @param {string} pluginId
 */
export function getPlugin(pluginId) {
  return _registry.get(pluginId);
}

/**
 * Daftar semua manifest plugin yang terdaftar.
 *
 * @returns {object[]}
 */
export function listPlugins() {
  return Array.from(_registry.values()).map((entry) => entry.manifest);
}

/**
 * Bersihkan semua plugin dari registry.
 * Gunakan hanya di test teardown — jangan panggil di production.
 */
export function clearRegistry() {
  _registry.clear();
}

/**
 * Seed permission dari manifest plugin ke tabel permissions di DB.
 * Idempotent: pakai onConflict doNothing — aman dipanggil berulang kali.
 *
 * @param {import("kysely").Kysely<unknown>} db
 * @param {object} manifest - Manifest plugin yang sudah tervalidasi
 */
export async function seedPluginPermissions(db, manifest) {
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) {
    return;
  }

  // Konversi permission string "awcms:sikesra:subject:read" ke format yang diharapkan collectRegisteredPluginPermissions
  const normalized = collectRegisteredPluginPermissions([
    {
      id: manifest.id,
      permissions: manifest.permissions.map((p) => {
        const parts = p.split(":");
        // Format: "awcms:{module}:{resource}:{action}" → parts[1]=module, [2]=resource, [3]=action
        const [, domain, resource, action] = parts;
        return { code: p, domain, resource, action };
      }),
    },
  ]);

  const permRepo = createPermissionRepository(db);

  for (const perm of normalized) {
    // Lewati jika sudah ada (idempotent)
    const existing = await permRepo.getPermissionById(perm.id).catch(() => null);
    if (existing) {
      continue;
    }

    await permRepo.createPermission({
      id: perm.id,
      code: perm.code,
      domain: perm.domain,
      resource: perm.resource,
      action: perm.action,
      description: perm.description ?? null,
      is_protected: perm.is_protected ?? false,
      created_at: null,
    });
  }
}
