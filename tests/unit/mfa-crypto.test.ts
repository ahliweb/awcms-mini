import { describe, expect, test } from "bun:test";

import {
  decryptMfaSecret,
  encryptMfaSecret,
  resolveMfaEncryptionKey
} from "../../src/lib/auth/mfa-secret-crypto";
import {
  generateRecoveryCode,
  hashRecoveryCode
} from "../../src/lib/auth/mfa-recovery-code";
import {
  generateChallengeToken,
  hashChallengeToken
} from "../../src/lib/auth/mfa-challenge-token";

const VALID_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");

describe("resolveMfaEncryptionKey", () => {
  test("null when unset", () => {
    expect(resolveMfaEncryptionKey({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("null when the decoded key is not exactly 32 bytes", () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    expect(
      resolveMfaEncryptionKey({
        AUTH_MFA_SECRET_ENCRYPTION_KEY: shortKey
      } as NodeJS.ProcessEnv)
    ).toBeNull();
  });

  test("returns a 32-byte buffer for a valid key", () => {
    const key = resolveMfaEncryptionKey({
      AUTH_MFA_SECRET_ENCRYPTION_KEY: VALID_KEY_BASE64
    } as NodeJS.ProcessEnv);
    expect(key).not.toBeNull();
    expect(key).toHaveLength(32);
  });
});

describe("encryptMfaSecret/decryptMfaSecret", () => {
  const key = resolveMfaEncryptionKey({
    AUTH_MFA_SECRET_ENCRYPTION_KEY: VALID_KEY_BASE64
  } as NodeJS.ProcessEnv)!;

  test("round-trips a secret", () => {
    const plaintext = Buffer.from("a-totp-secret-payload");
    const ciphertext = encryptMfaSecret(plaintext, key);
    expect(ciphertext).not.toContain("a-totp-secret-payload");
    expect(decryptMfaSecret(ciphertext, key)).toEqual(plaintext);
  });

  test("two encryptions of the same plaintext produce different ciphertext (random IV)", () => {
    const plaintext = Buffer.from("same-secret");
    const a = encryptMfaSecret(plaintext, key);
    const b = encryptMfaSecret(plaintext, key);
    expect(a).not.toBe(b);
  });

  test("decrypting with the wrong key throws (authenticated cipher rejects it)", () => {
    const otherKey = Buffer.alloc(32, 9);
    const ciphertext = encryptMfaSecret(Buffer.from("secret"), key);
    expect(() => decryptMfaSecret(ciphertext, otherKey)).toThrow();
  });

  test("decrypting a tampered ciphertext throws", () => {
    const ciphertext = encryptMfaSecret(Buffer.from("secret"), key);
    const parts = ciphertext.split(":");
    const tamperedCiphertextPart = Buffer.from(parts[3]!, "base64");
    tamperedCiphertextPart[0] = (tamperedCiphertextPart[0]! + 1) % 256;
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      tamperedCiphertextPart.toString("base64")
    ].join(":");

    expect(() => decryptMfaSecret(tampered, key)).toThrow();
  });

  test("decrypting an unrecognized format throws", () => {
    expect(() => decryptMfaSecret("not-a-valid-format", key)).toThrow();
    expect(() => decryptMfaSecret("v2:a:b:c", key)).toThrow();
  });
});

describe("generateRecoveryCode/hashRecoveryCode", () => {
  test("produces an XXXX-XXXX shaped code", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  test("generates distinct codes across calls", () => {
    const codes = new Set(
      Array.from({ length: 20 }, () => generateRecoveryCode())
    );
    expect(codes.size).toBe(20);
  });

  test("hash is stable and normalizes case/dash before hashing", () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hash);
    expect(hashRecoveryCode(code.replace("-", ""))).toBe(hash);
    expect(hashRecoveryCode(` ${code} `.trim())).toBe(hash);
  });

  test("different codes hash differently", () => {
    expect(hashRecoveryCode("AAAA-AAAA")).not.toBe(
      hashRecoveryCode("BBBB-BBBB")
    );
  });
});

describe("generateChallengeToken/hashChallengeToken", () => {
  test("generates a base64url token and a stable sha256 hash", () => {
    const token = generateChallengeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const hash = hashChallengeToken(token);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashChallengeToken(token)).toBe(hash);
  });

  test("different tokens hash differently", () => {
    const a = generateChallengeToken();
    const b = generateChallengeToken();
    expect(hashChallengeToken(a)).not.toBe(hashChallengeToken(b));
  });
});
