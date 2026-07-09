import { describe, expect, test } from "bun:test";

import {
  decryptSsoClientSecret,
  encryptSsoClientSecret,
  resolveSsoEncryptionKey
} from "../../src/lib/auth/sso-credential-crypto";

const VALID_KEY_BASE64 = Buffer.alloc(32, 5).toString("base64");

describe("resolveSsoEncryptionKey", () => {
  test("null when unset", () => {
    expect(resolveSsoEncryptionKey({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("null when the decoded key is not exactly 32 bytes", () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    expect(
      resolveSsoEncryptionKey({
        AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY: shortKey
      } as NodeJS.ProcessEnv)
    ).toBeNull();
  });

  test("returns a 32-byte buffer for a valid key", () => {
    const key = resolveSsoEncryptionKey({
      AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY: VALID_KEY_BASE64
    } as NodeJS.ProcessEnv);
    expect(key).not.toBeNull();
    expect(key).toHaveLength(32);
  });
});

describe("encryptSsoClientSecret/decryptSsoClientSecret", () => {
  const key = resolveSsoEncryptionKey({
    AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY: VALID_KEY_BASE64
  } as NodeJS.ProcessEnv)!;

  test("round-trips a client secret", () => {
    const plaintext = "super-secret-oidc-client-secret";
    const ciphertext = encryptSsoClientSecret(plaintext, key);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptSsoClientSecret(ciphertext, key)).toBe(plaintext);
  });

  test("two encryptions of the same plaintext produce different ciphertext (random IV)", () => {
    const a = encryptSsoClientSecret("same-secret", key);
    const b = encryptSsoClientSecret("same-secret", key);
    expect(a).not.toBe(b);
  });

  test("decrypting with the wrong key throws (authenticated cipher rejects it)", () => {
    const otherKey = Buffer.alloc(32, 9);
    const ciphertext = encryptSsoClientSecret("secret", key);
    expect(() => decryptSsoClientSecret(ciphertext, otherKey)).toThrow();
  });

  test("decrypting a tampered ciphertext throws", () => {
    const ciphertext = encryptSsoClientSecret("secret", key);
    const parts = ciphertext.split(":");
    const tamperedCiphertextPart = Buffer.from(parts[3]!, "base64");
    tamperedCiphertextPart[0] = (tamperedCiphertextPart[0]! + 1) % 256;
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      tamperedCiphertextPart.toString("base64")
    ].join(":");

    expect(() => decryptSsoClientSecret(tampered, key)).toThrow();
  });

  test("decrypting an unrecognized format throws", () => {
    expect(() => decryptSsoClientSecret("not-a-valid-format", key)).toThrow();
    expect(() => decryptSsoClientSecret("v2:a:b:c", key)).toThrow();
  });
});
