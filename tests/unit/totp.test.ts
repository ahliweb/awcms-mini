import { describe, expect, test } from "bun:test";

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode
} from "../../src/lib/auth/totp";

describe("base32Encode/base32Decode", () => {
  test("round-trips arbitrary byte buffers", () => {
    const buffers = [
      Buffer.from([]),
      Buffer.from([0]),
      Buffer.from([255]),
      Buffer.from("hello world"),
      Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7))
    ];

    for (const buffer of buffers) {
      const encoded = base32Encode(buffer);
      expect(base32Decode(encoded)).toEqual(buffer);
    }
  });

  test("encodes using only the RFC 4648 base32 alphabet, no padding", () => {
    const encoded = base32Encode(Buffer.from("12345678901234567890"));
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(encoded).not.toContain("=");
  });

  test("decode tolerates lowercase, padding, and stray whitespace", () => {
    const original = Buffer.from("test-secret-bytes!!");
    const encoded = base32Encode(original);
    const messy = `  ${encoded.toLowerCase()}==  `;
    expect(base32Decode(messy)).toEqual(original);
  });
});

describe("generateTotpSecret", () => {
  test("returns 20 random bytes (160 bits, RFC 4226 recommended length)", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toHaveLength(20);
    expect(a.equals(b)).toBe(false);
  });
});

describe("verifyTotpCode — RFC 6238 Appendix B test vectors", () => {
  // The 20-byte ASCII secret "12345678901234567890" and its known 8-digit
  // SHA1 codes at fixed Unix timestamps, straight from RFC 6238 Appendix B —
  // proves this implementation is bit-for-bit RFC-compatible (and therefore
  // Google Authenticator-compatible), not just internally self-consistent.
  const SECRET = Buffer.from("12345678901234567890", "ascii");
  const VECTORS: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"]
  ];

  for (const [timeSec, expectedCode] of VECTORS) {
    test(`matches at T=${timeSec}`, () => {
      const step = Math.floor(timeSec / 30);
      const matchedStep = verifyTotpCode(SECRET, expectedCode, timeSec * 1000, {
        periodSec: 30,
        digits: 8,
        windowSteps: 0
      });
      expect(matchedStep).toBe(step);
    });
  }

  test("rejects a wrong code at a known-good timestamp", () => {
    const matchedStep = verifyTotpCode(SECRET, "00000000", 59 * 1000, {
      periodSec: 30,
      digits: 8,
      windowSteps: 0
    });
    expect(matchedStep).toBeNull();
  });

  test("rejects a code of the wrong length even if numeric", () => {
    const matchedStep = verifyTotpCode(SECRET, "9428708", 59 * 1000, {
      periodSec: 30,
      digits: 8,
      windowSteps: 0
    });
    expect(matchedStep).toBeNull();
  });

  test("rejects a non-numeric code", () => {
    const matchedStep = verifyTotpCode(SECRET, "abcdefgh", 59 * 1000, {
      periodSec: 30,
      digits: 8,
      windowSteps: 0
    });
    expect(matchedStep).toBeNull();
  });

  test("tolerates clock drift within the window (±1 step by default)", () => {
    // T=59 -> step 1, code 94287082. One period later (step 2) is outside a
    // zero-window check but inside the default ±1 window.
    const oneStepLater = (59 + 30) * 1000;
    const matchedStep = verifyTotpCode(SECRET, "94287082", oneStepLater, {
      periodSec: 30,
      digits: 8
    });
    expect(matchedStep).toBe(1);
  });

  test("rejects drift beyond the configured window", () => {
    const twoStepsLater = (59 + 60) * 1000;
    const matchedStep = verifyTotpCode(SECRET, "94287082", twoStepsLater, {
      periodSec: 30,
      digits: 8,
      windowSteps: 1
    });
    expect(matchedStep).toBeNull();
  });
});

describe("generateTotpCode", () => {
  test("matches the known RFC 6238 vector at T=59", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    expect(
      generateTotpCode(secret, 59 * 1000, { periodSec: 30, digits: 8 })
    ).toBe("94287082");
  });

  test("round-trips with verifyTotpCode for a freshly generated secret", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now, { periodSec: 30, digits: 6 });
    const matchedStep = verifyTotpCode(secret, code, now, {
      periodSec: 30,
      digits: 6
    });
    expect(matchedStep).toBe(Math.floor(now / 1000 / 30));
  });
});

describe("buildOtpauthUri", () => {
  test("produces a well-formed otpauth:// URI with the expected query params", () => {
    const uri = buildOtpauthUri({
      secret: Buffer.from("12345678901234567890", "ascii"),
      issuer: "AWCMS-Mini",
      accountName: "owner@example.com",
      digits: 6,
      periodSec: 30
    });

    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("issuer=AWCMS-Mini");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("algorithm=SHA1");
    expect(decodeURIComponent(uri)).toContain("AWCMS-Mini:owner@example.com");
  });
});
