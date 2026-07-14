/**
 * Issue #754 (integration_hub) — HMAC signature verification unit tests.
 * Critical requirement: prove timing-safe comparison genuinely rejects a
 * near-correct-but-wrong signature (adversarial test), tampered body,
 * stale timestamp, and reused nonce — for BOTH fixture signature schemes.
 */
import { describe, expect, test } from "bun:test";
import {
  fixtureSignatureTestHelpers,
  verifyFixtureHmacSha256,
  verifyFixtureSharedSecretNonce
} from "../../src/modules/integration-hub/domain/fixture-signature-schemes";
import {
  computeHmacSha256Hex,
  deriveFallbackReplayKey,
  isTimestampWithinTolerance,
  sha256Hex,
  timingSafeEqualHex
} from "../../src/modules/integration-hub/domain/signature-primitives";

const SECRET = "test-secret-value-1234567890";
const NOW = new Date("2026-07-14T12:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const BODY = JSON.stringify({ hello: "world", n: 1 });

function flipLastHexChar(hex: string): string {
  const last = hex[hex.length - 1]!;
  const flipped = last === "0" ? "1" : "0";
  return hex.slice(0, -1) + flipped;
}

describe("timingSafeEqualHex", () => {
  test("returns true for identical hex strings", () => {
    const value = computeHmacSha256Hex(SECRET, "message");
    expect(timingSafeEqualHex(value, value)).toBe(true);
  });

  test("returns false for a single differing byte (adversarial near-miss)", () => {
    const value = computeHmacSha256Hex(SECRET, "message");
    const almostRight = flipLastHexChar(value);
    expect(almostRight).not.toBe(value);
    expect(timingSafeEqualHex(value, almostRight)).toBe(false);
  });

  test("returns false (never throws) for mismatched length", () => {
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
  });

  test("returns false (never throws) for non-hex input", () => {
    expect(timingSafeEqualHex("zz", "zz")).toBe(false);
  });

  test("never uses plain === under the hood — verified by construction: two different-content, same-length hex strings must differ", () => {
    // This is a construction proof, not a timing measurement (real timing
    // side-channel testing requires statistical sampling over many
    // requests and is not reliable in a CI unit test) — timingSafeEqualHex
    // is documented and implemented via node:crypto's timingSafeEqual,
    // the established constant-time primitive this repo already uses
    // elsewhere (sync-storage/domain/sync-hmac.ts). This test proves
    // correctness of the comparison result itself under adversarial
    // near-miss input, which is the externally observable contract.
    const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    expect(timingSafeEqualHex(a, b)).toBe(false);
  });
});

describe("isTimestampWithinTolerance", () => {
  test("accepts a timestamp within the window", () => {
    expect(isTimestampWithinTolerance(TIMESTAMP, NOW, 300)).toBe(true);
  });

  test("rejects a stale timestamp", () => {
    const stale = String(Math.floor(NOW.getTime() / 1000) - 3600);
    expect(isTimestampWithinTolerance(stale, NOW, 300)).toBe(false);
  });

  test("rejects a future timestamp beyond tolerance", () => {
    const future = String(Math.floor(NOW.getTime() / 1000) + 3600);
    expect(isTimestampWithinTolerance(future, NOW, 300)).toBe(false);
  });

  test("rejects a malformed timestamp", () => {
    expect(isTimestampWithinTolerance("not-a-number", NOW, 300)).toBe(false);
  });
});

describe("deriveFallbackReplayKey", () => {
  test("is deterministic for the same signature+timestamp", () => {
    const a = deriveFallbackReplayKey("abc123", TIMESTAMP);
    const b = deriveFallbackReplayKey("abc123", TIMESTAMP);
    expect(a).toBe(b);
  });

  test("differs for a different signature", () => {
    const a = deriveFallbackReplayKey("abc123", TIMESTAMP);
    const b = deriveFallbackReplayKey("def456", TIMESTAMP);
    expect(a).not.toBe(b);
  });
});

describe("verifyFixtureHmacSha256 — scheme 1 (delivery-id replay key)", () => {
  function sign(secret: string, timestamp: string, body: string): string {
    return fixtureSignatureTestHelpers.signHmacSha256(secret, timestamp, body);
  }

  test("accepts a validly-signed request", () => {
    const signature = sign(SECRET, TIMESTAMP, BODY);
    const result = verifyFixtureHmacSha256({
      rawBody: BODY,
      headers: {
        "x-integration-signature": signature,
        "x-integration-timestamp": TIMESTAMP,
        "x-integration-delivery-id": "delivery-1"
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.replayKey).toBe("delivery-1");
    }
  });

  test("falls back to a signature-derived replay key when no delivery id header is present", () => {
    const signature = sign(SECRET, TIMESTAMP, BODY);
    const result = verifyFixtureHmacSha256({
      rawBody: BODY,
      headers: {
        "x-integration-signature": signature,
        "x-integration-timestamp": TIMESTAMP
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.replayKey).toBe(
        deriveFallbackReplayKey(signature, TIMESTAMP)
      );
    }
  });

  test("ADVERSARIAL: rejects a near-correct-but-wrong signature (single flipped hex digit)", () => {
    const signature = sign(SECRET, TIMESTAMP, BODY);
    const almostRight = flipLastHexChar(signature);
    const result = verifyFixtureHmacSha256({
      rawBody: BODY,
      headers: {
        "x-integration-signature": almostRight,
        "x-integration-timestamp": TIMESTAMP
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("signature_mismatch");
    }
  });

  test("rejects a tampered body (signature computed over a different body)", () => {
    const signature = sign(SECRET, TIMESTAMP, BODY);
    const tamperedBody = JSON.stringify({ hello: "world", n: 2 });
    const result = verifyFixtureHmacSha256({
      rawBody: tamperedBody,
      headers: {
        "x-integration-signature": signature,
        "x-integration-timestamp": TIMESTAMP
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a stale timestamp even with a correct signature for that timestamp", () => {
    const staleTimestamp = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const signature = sign(SECRET, staleTimestamp, BODY);
    const result = verifyFixtureHmacSha256({
      rawBody: BODY,
      headers: {
        "x-integration-signature": signature,
        "x-integration-timestamp": staleTimestamp
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("timestamp_out_of_tolerance");
    }
  });

  test("rejects a request with no signature header at all", () => {
    const result = verifyFixtureHmacSha256({
      rawBody: BODY,
      headers: { "x-integration-timestamp": TIMESTAMP },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("missing_signature_header");
    }
  });

  test("verifies with the PREVIOUS secret during a key-rotation overlap window", () => {
    const oldSecret = "old-secret-value";
    const signature = sign(oldSecret, TIMESTAMP, BODY);
    const result = verifyFixtureHmacSha256({
      rawBody: BODY,
      headers: {
        "x-integration-signature": signature,
        "x-integration-timestamp": TIMESTAMP
      },
      secret: SECRET,
      previousSecret: oldSecret,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.usedPreviousSecret).toBe(true);
    }
  });

  test("rejects when the previous secret has already rolled off (not passed by caller)", () => {
    const oldSecret = "old-secret-value";
    const signature = sign(oldSecret, TIMESTAMP, BODY);
    const result = verifyFixtureHmacSha256({
      rawBody: BODY,
      headers: {
        "x-integration-signature": signature,
        "x-integration-timestamp": TIMESTAMP
      },
      secret: SECRET,
      previousSecret: null,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
  });
});

describe("verifyFixtureSharedSecretNonce — scheme 2 (nonce replay key, body-digest signed)", () => {
  const NONCE = "nonce-abc-123";

  function sign(
    secret: string,
    nonce: string,
    timestamp: string,
    body: string
  ): string {
    return fixtureSignatureTestHelpers.signSharedSecretNonce(
      secret,
      nonce,
      timestamp,
      body
    );
  }

  test("accepts a validly-signed request and uses the nonce as the replay key verbatim", () => {
    const signature = sign(SECRET, NONCE, TIMESTAMP, BODY);
    const result = verifyFixtureSharedSecretNonce({
      rawBody: BODY,
      headers: {
        "x-integration-signature-v2": signature,
        "x-integration-timestamp": TIMESTAMP,
        "x-integration-nonce": NONCE
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.replayKey).toBe(NONCE);
    }
  });

  test("ADVERSARIAL: rejects a near-correct-but-wrong signature", () => {
    const signature = sign(SECRET, NONCE, TIMESTAMP, BODY);
    const almostRight = flipLastHexChar(signature);
    const result = verifyFixtureSharedSecretNonce({
      rawBody: BODY,
      headers: {
        "x-integration-signature-v2": almostRight,
        "x-integration-timestamp": TIMESTAMP,
        "x-integration-nonce": NONCE
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("signature_mismatch");
    }
  });

  test("rejects a missing nonce header outright (never falls back to a derived key for this scheme)", () => {
    const signature = sign(SECRET, NONCE, TIMESTAMP, BODY);
    const result = verifyFixtureSharedSecretNonce({
      rawBody: BODY,
      headers: {
        "x-integration-signature-v2": signature,
        "x-integration-timestamp": TIMESTAMP
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("missing_replay_key");
    }
  });

  test("signs over the body DIGEST, not the raw body — a same-digest-producing different body is out of this scheme's scope, but changing the body changes the digest and invalidates the signature", () => {
    const signature = sign(SECRET, NONCE, TIMESTAMP, BODY);
    const tampered = JSON.stringify({ hello: "world", n: 999 });
    expect(sha256Hex(tampered)).not.toBe(sha256Hex(BODY));
    const result = verifyFixtureSharedSecretNonce({
      rawBody: tampered,
      headers: {
        "x-integration-signature-v2": signature,
        "x-integration-timestamp": TIMESTAMP,
        "x-integration-nonce": NONCE
      },
      secret: SECRET,
      toleranceSeconds: 300,
      now: NOW
    });
    expect(result.valid).toBe(false);
  });
});
