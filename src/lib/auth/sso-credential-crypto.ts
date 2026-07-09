/**
 * Encryption-at-rest for generic tenant OIDC SSO client secrets (Issue
 * #591). Identical shape and rationale to Issue #589's
 * `mfa-secret-crypto.ts` (AES-256-GCM, versioned `v1:<iv>:<tag>:<ciphertext>`
 * format, fail-closed key resolution) — a SEPARATE key
 * (`AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY`) from MFA's own
 * `AUTH_MFA_SECRET_ENCRYPTION_KEY`, deliberately: rotating/compromising one
 * secret class must never affect the other, and each key's blast radius
 * stays scoped to the one column it protects
 * (`awcms_mini_auth_providers.client_secret_ciphertext`).
 *
 * Unlike a TOTP seed, an OIDC client secret is only ever needed at
 * token-exchange time (never a per-request HMAC-style comparison), but it
 * still must be recoverable in full (not hashed) — the provider's own
 * token endpoint expects the literal secret value.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const FORMAT_VERSION = "v1";

/**
 * Decodes and validates `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY` from env.
 * Returns `null` — never throws — if unset or not exactly 32 bytes once
 * base64-decoded, so every caller can fail closed (treat "no usable key" as
 * "cannot encrypt/decrypt this provider's secret") rather than crash.
 */
export function resolveSsoEncryptionKey(
  env: NodeJS.ProcessEnv = process.env
): Buffer | null {
  const raw = env.AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY;

  if (!raw) {
    return null;
  }

  let key: Buffer;

  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }

  return key.length === KEY_BYTE_LENGTH ? key : null;
}

/** `v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>` — versioned so the format can evolve without breaking already-encrypted rows. */
export function encryptSsoClientSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64")
  ].join(":");
}

/** Throws if `encoded` is malformed, the tag doesn't authenticate, or the version is unrecognized — callers must treat any throw as "cannot decrypt", never as "empty secret". */
export function decryptSsoClientSecret(encoded: string, key: Buffer): string {
  const parts = encoded.split(":");

  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Unrecognized SSO client secret ciphertext format.");
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart!, "base64");
  const authTag = Buffer.from(tagPart!, "base64");
  const ciphertext = Buffer.from(ciphertextPart!, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}
