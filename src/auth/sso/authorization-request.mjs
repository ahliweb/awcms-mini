/**
 * OIDC login initiation — Tahap 2 (#351, ADR-024). Modul **pure** (hanya
 * `node:crypto`, tanpa I/O) agar mudah diuji tanpa IdP nyata.
 *
 * Cakupan: membangun Authorization Request + parameter anti-forgery, dan
 * memvalidasi parameter callback. Pertukaran code→token & verifikasi ID token
 * (JWKS/iss/aud/nonce) menyusul di slice berikutnya.
 *
 * Keamanan (standar SSO §3/§6):
 *   - `state`  — anti-CSRF; wajib cocok saat callback.
 *   - `nonce`  — anti-replay ID token; diverifikasi saat validasi ID token.
 *   - PKCE S256 — `code_verifier`/`code_challenge` mencegah code interception.
 *   - `redirect_uri` WAJIB HTTPS dan berada di allowlist (cegah open redirect
 *     & token leakage). authorization_endpoint WAJIB HTTPS.
 *   - `code_verifier` bersifat rahasia sesi — JANGAN dikirim ke authorize,
 *     hanya dipakai saat token exchange.
 */

import { createHash, randomBytes } from "node:crypto";

function base64UrlRandom(byteLength = 32) {
  return randomBytes(byteLength).toString("base64url");
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Buat parameter anti-forgery untuk satu percobaan login OIDC.
 * `state`/`nonce`/`codeVerifier` harus disimpan di sisi server (terikat sesi),
 * bukan dibocorkan ke klien selain lewat Authorization Request.
 *
 * @returns {{ state: string, nonce: string, codeVerifier: string, codeChallenge: string, codeChallengeMethod: "S256" }}
 */
export function createOidcLoginState() {
  const codeVerifier = base64UrlRandom(32);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  return {
    state: base64UrlRandom(32),
    nonce: base64UrlRandom(32),
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}

/**
 * Bangun URL Authorization Request OIDC (response_type=code + PKCE).
 *
 * @param {object} provider provider ternormalkan (lihat validateSsoProviderConfig)
 * @param {object} params { redirectUri, state, nonce, codeChallenge, allowedRedirectUris }
 * @returns {string} URL absolut ke authorization_endpoint
 * @throws {Error} bila endpoint/redirect tidak memenuhi syarat keamanan
 */
export function buildAuthorizationRequestUrl(provider, params = {}) {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("provider wajib berupa objek terkonfigurasi.");
  }
  if (!isHttpsUrl(provider.authorization_endpoint)) {
    throw new Error("authorization_endpoint provider harus URL HTTPS yang valid.");
  }

  const { redirectUri, state, nonce, codeChallenge, allowedRedirectUris } = params;

  if (!isHttpsUrl(redirectUri)) {
    throw new Error("redirect_uri harus URL HTTPS yang valid.");
  }
  // Allowlist wajib bila diberikan — cegah open redirect / token leakage.
  if (Array.isArray(allowedRedirectUris) && !allowedRedirectUris.includes(redirectUri)) {
    throw new Error("redirect_uri tidak berada di allowlist.");
  }
  for (const [name, value] of [
    ["state", state],
    ["nonce", nonce],
    ["codeChallenge", codeChallenge],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${name} wajib diisi (string non-kosong).`);
    }
  }

  const url = new URL(provider.authorization_endpoint);
  const scopes = Array.isArray(provider.scopes) && provider.scopes.length > 0 ? provider.scopes : ["openid"];
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

/**
 * Validasi parameter callback dari IdP.
 * Memakai perbandingan panjang-tetap untuk `state` (anti timing).
 *
 * @param {object} args { params, expectedState }
 * @returns {{ code: string, state: string }}
 * @throws {Error} bila IdP mengembalikan error, state tak cocok, atau code hilang
 */
export function validateAuthorizationCallback({ params = {}, expectedState } = {}) {
  if (typeof params.error === "string" && params.error.trim() !== "") {
    throw new Error(`IdP mengembalikan error: ${params.error}`);
  }
  if (typeof expectedState !== "string" || expectedState.trim() === "") {
    throw new Error("expectedState (state sesi) tidak tersedia.");
  }
  if (typeof params.state !== "string" || !timingSafeEqualString(params.state, expectedState)) {
    throw new Error("state callback tidak cocok — kemungkinan CSRF.");
  }
  if (typeof params.code !== "string" || params.code.trim() === "") {
    throw new Error("authorization code tidak ada di callback.");
  }

  return { code: params.code, state: params.state };
}

function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
