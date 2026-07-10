import { describe, expect, test } from "bun:test";

import {
  generateVisitorKey,
  hashIpAddress,
  hashUserAgent,
  hashVisitorKey,
  isValidVisitorKey,
  resolveVisitorKey
} from "../../src/modules/visitor-analytics/domain/visitor-key";

describe("generateVisitorKey", () => {
  test("returns a UUID-shaped string", () => {
    expect(isValidVisitorKey(generateVisitorKey())).toBe(true);
  });

  test("returns a different value on every call", () => {
    expect(generateVisitorKey()).not.toBe(generateVisitorKey());
  });
});

describe("isValidVisitorKey", () => {
  test("accepts a well-formed UUID", () => {
    expect(isValidVisitorKey("550e8400-e29b-41d4-a716-446655440000")).toBe(
      true
    );
  });

  test("rejects non-UUID, empty, undefined, and null values", () => {
    expect(isValidVisitorKey("not-a-uuid")).toBe(false);
    expect(isValidVisitorKey("")).toBe(false);
    expect(isValidVisitorKey(undefined)).toBe(false);
    expect(isValidVisitorKey(null)).toBe(false);
  });
});

describe("resolveVisitorKey", () => {
  test("reuses a valid existing key", () => {
    const existing = "550e8400-e29b-41d4-a716-446655440000";
    expect(resolveVisitorKey(existing)).toBe(existing);
  });

  test("mints a new key when the existing value is missing or forged", () => {
    expect(isValidVisitorKey(resolveVisitorKey(undefined))).toBe(true);
    expect(isValidVisitorKey(resolveVisitorKey(null))).toBe(true);
    expect(
      isValidVisitorKey(resolveVisitorKey("<script>alert(1)</script>"))
    ).toBe(true);
  });
});

describe("salted hash helpers", () => {
  test("hashVisitorKey/hashIpAddress/hashUserAgent are deterministic and sha256:-prefixed", () => {
    const salt = "deployment-salt";
    expect(hashVisitorKey("visitor-1", salt)).toBe(
      hashVisitorKey("visitor-1", salt)
    );
    expect(hashVisitorKey("visitor-1", salt)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashIpAddress("203.0.113.1", salt)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashUserAgent("Mozilla/5.0", salt)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("different salts produce different hashes for the same value", () => {
    expect(hashIpAddress("203.0.113.1", "salt-a")).not.toBe(
      hashIpAddress("203.0.113.1", "salt-b")
    );
  });

  test("different values produce different hashes under the same salt", () => {
    const salt = "deployment-salt";
    expect(hashVisitorKey("visitor-1", salt)).not.toBe(
      hashVisitorKey("visitor-2", salt)
    );
  });

  test("never returns the raw input value", () => {
    const salt = "deployment-salt";
    expect(hashIpAddress("203.0.113.1", salt)).not.toContain("203.0.113.1");
    expect(hashUserAgent("Mozilla/5.0 secret-marker", salt)).not.toContain(
      "secret-marker"
    );
  });
});
