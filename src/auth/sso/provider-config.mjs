/**
 * Kontrak konfigurasi provider SSO (ADR-024 / DL-022, #351 Tahap 1).
 *
 * Validasi & normalisasi konfigurasi provider SSO sebelum persist ke
 * `auth.sso_providers`. Modul **pure** (tanpa I/O) agar mudah diuji.
 *
 * Keamanan (standar SSO §6/§8):
 *   - Kontrak ini TIDAK menerima/menyimpan/mencetak secret IdP mentah. Secret
 *     ditangani terpisah sebagai `client_secret_enc` (AES-256-GCM, pola
 *     src/security/totp.mjs) di lapisan persistensi — bukan di kontrak ini.
 *   - `redirect_uri` divalidasi (whitelist) di Tahap 2 (alur login), bukan di sini.
 *
 * Cakupan single-tenant (awcms-mini): tanpa `tenant_id`. awcms multi-tenant
 * memperluas kontrak ini dengan resolusi tenant.
 */

/** Jenis provider yang didukung (OIDC primer; SAML opsional). */
export const SSO_PROVIDER_KINDS = Object.freeze(["oidc", "saml"]);

/** Scope OIDC default bila tidak ditentukan. */
export const DEFAULT_OIDC_SCOPES = Object.freeze(["openid", "email", "profile"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeStringArray(value, fallback) {
  if (value === undefined || value === null) return fallback ? [...fallback] : [];
  if (!Array.isArray(value)) {
    throw new TypeError("scopes/allowed_email_domains harus array string.");
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!isNonEmptyString(item)) continue;
    const v = item.trim().toLowerCase();
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Validasi & normalkan konfigurasi provider SSO.
 *
 * @param {object} input konfigurasi mentah (mis. dari API/seed)
 * @returns {object} konfigurasi ternormalkan siap persist (tanpa secret mentah)
 * @throws {TypeError|Error} bila tidak valid
 */
export function validateSsoProviderConfig(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Konfigurasi provider SSO harus berupa objek.");
  }

  const kind = isNonEmptyString(input.kind) ? input.kind.trim().toLowerCase() : "";
  if (!SSO_PROVIDER_KINDS.includes(kind)) {
    throw new Error(
      `kind tidak valid: "${input.kind}". Harus salah satu dari ${SSO_PROVIDER_KINDS.join(", ")}.`,
    );
  }

  if (!isNonEmptyString(input.display_name)) {
    throw new Error("display_name wajib diisi.");
  }
  if (!isNonEmptyString(input.issuer)) {
    throw new Error("issuer wajib diisi.");
  }
  // issuer OIDC WAJIB HTTPS (standar SSO §3 — validasi iss + JWKS via issuer).
  if (kind === "oidc" && !isHttpsUrl(input.issuer)) {
    throw new Error("issuer OIDC harus URL HTTPS yang valid.");
  }
  if (!isNonEmptyString(input.client_id)) {
    throw new Error("client_id wajib diisi.");
  }

  // Endpoint opsional, tapi bila diisi WAJIB HTTPS (cegah token leakage §6).
  for (const field of ["jwks_uri", "authorization_endpoint", "token_endpoint"]) {
    if (input[field] !== undefined && input[field] !== null && !isHttpsUrl(input[field])) {
      throw new Error(`${field} harus URL HTTPS yang valid bila diisi.`);
    }
  }

  const claimMappings =
    input.claim_mappings === undefined || input.claim_mappings === null
      ? {}
      : input.claim_mappings;
  if (typeof claimMappings !== "object" || Array.isArray(claimMappings)) {
    throw new TypeError("claim_mappings harus objek (peta klaim → atribut internal).");
  }

  return {
    kind,
    display_name: input.display_name.trim(),
    issuer: input.issuer.trim(),
    client_id: input.client_id.trim(),
    jwks_uri: isNonEmptyString(input.jwks_uri) ? input.jwks_uri.trim() : null,
    authorization_endpoint: isNonEmptyString(input.authorization_endpoint)
      ? input.authorization_endpoint.trim()
      : null,
    token_endpoint: isNonEmptyString(input.token_endpoint) ? input.token_endpoint.trim() : null,
    scopes: normalizeStringArray(input.scopes, DEFAULT_OIDC_SCOPES),
    claim_mappings: claimMappings,
    allow_jit: input.allow_jit === true,
    allowed_email_domains: normalizeStringArray(input.allowed_email_domains),
    enabled: input.enabled === undefined ? true : input.enabled === true,
  };
}
