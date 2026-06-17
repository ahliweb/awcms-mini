// Kontrak manifest plugin AWCMS-Mini (ADR-018, ADR-009)
// Setiap plugin wajib memiliki manifest tervalidasi sebelum bisa di-register.

const KEBAB_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const SNAKE_RE = /^[a-z][a-z0-9_]*[a-z0-9]$/;
const PERM_RE = /^awcms:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Validasi manifest plugin AWCMS-Mini.
 * Mengembalikan array error. Array kosong berarti manifest valid.
 *
 * @param {unknown} manifest
 * @returns {{ field: string; message: string }[]}
 */
export function validatePluginManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    return [{ field: "manifest", message: "Manifest harus berupa object." }];
  }

  // id: kebab-case, minimal 3 karakter
  if (!KEBAB_RE.test(manifest.id ?? "")) {
    errors.push({ field: "id", message: 'id harus kebab-case (contoh: "sikesra", "satu-sehat-kobar").' });
  }

  // name: string non-kosong
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    errors.push({ field: "name", message: "name wajib diisi (string non-kosong)." });
  }

  // version: semver x.y.z
  if (!SEMVER_RE.test(manifest.version ?? "")) {
    errors.push({ field: "version", message: 'version harus semver (contoh: "0.1.0").' });
  }

  // kind: wajib "awcms-mini-plugin"
  if (manifest.kind !== "awcms-mini-plugin") {
    errors.push({ field: "kind", message: 'kind harus "awcms-mini-plugin".' });
  }

  // appliesTo: array yang mengandung "awcms-mini"
  if (!Array.isArray(manifest.appliesTo) || !manifest.appliesTo.includes("awcms-mini")) {
    errors.push({ field: "appliesTo", message: 'appliesTo harus array yang mengandung "awcms-mini".' });
  }

  // permissions: setiap item harus mengikuti namespace awcms:{module}:{resource}:{action}
  if (Array.isArray(manifest.permissions)) {
    manifest.permissions.forEach((p, i) => {
      if (typeof p !== "string" || !PERM_RE.test(p)) {
        errors.push({
          field: `permissions[${i}]`,
          message: `"${p}" harus mengikuti pola awcms:{module}:{resource}:{action}.`,
        });
      }
    });
  }

  // data: wajib ada
  const data = manifest.data;
  if (!data || typeof data !== "object") {
    errors.push({ field: "data", message: "data wajib ada (object dengan adapter, schema, rls)." });
  } else {
    // data.adapter: wajib "postgres" untuk awcms-mini-plugin
    if (data.adapter !== "postgres") {
      errors.push({ field: "data.adapter", message: 'data.adapter wajib "postgres" untuk awcms-mini-plugin (ADR-018).' });
    }

    // data.schema: snake_case
    if (!SNAKE_RE.test(data.schema ?? "")) {
      errors.push({ field: "data.schema", message: 'data.schema harus snake_case (contoh: "sikesra", "satu_sehat_kobar").' });
    }

    // data.rls: wajib "required" (ADR-015)
    if (data.rls !== "required") {
      errors.push({ field: "data.rls", message: 'data.rls wajib "required" — RLS enforced pada semua tabel plugin (ADR-015).' });
    }
  }

  // audit: jika required=true, events tidak boleh kosong
  const audit = manifest.audit;
  if (audit && audit.required === true) {
    if (!Array.isArray(audit.events) || audit.events.length === 0) {
      errors.push({ field: "audit.events", message: "audit.events tidak boleh kosong bila audit.required=true." });
    }
  }

  return errors;
}

/**
 * Validasi manifest dan lempar Error jika tidak valid.
 * Gunakan ini di registry untuk memblokir registrasi plugin yang rusak.
 *
 * @param {unknown} manifest
 * @returns {unknown} manifest yang valid (passthrough)
 */
export function assertValidPluginManifest(manifest) {
  const errors = validatePluginManifest(manifest);

  if (errors.length > 0) {
    const detail = errors.map((e) => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`Manifest plugin tidak valid:\n${detail}`);
  }

  return manifest;
}

/**
 * Kembalikan true jika manifest valid (tidak ada error).
 *
 * @param {unknown} manifest
 * @returns {boolean}
 */
export function isValidPluginManifest(manifest) {
  return validatePluginManifest(manifest).length === 0;
}
