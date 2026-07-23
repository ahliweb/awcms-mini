/**
 * Unit tests for the usage_metering unique_dimension pseudonym (Issue #902 L2,
 * epic #868, ADR-0022 §3/§8). Verifies the HMAC is deterministic
 * (cardinality-preserving), domain-separated from the audit `ipHash` (so the two
 * `AUTH_JWT_SECRET`-keyed digests never collide), charset-clean (a 64-hex digest
 * satisfies the column CHECK + domain charset), and fail-closed on a missing /
 * placeholder secret.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { pseudonymizeUniqueDimension } from "../../src/modules/usage-metering/application/unique-dimension-pseudonym";
import { hashClientIp } from "../../src/lib/security/client-fingerprint";
import { findConfigVarEntry } from "../../src/lib/config/registry";

const SECRET = "unit-test-unique-dimension-secret";

describe("usage_metering unique_dimension pseudonym", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.AUTH_JWT_SECRET;
    process.env.AUTH_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });

  test("is deterministic (cardinality-preserving) — same input, same digest", () => {
    expect(pseudonymizeUniqueDimension("subject-A")).toBe(
      pseudonymizeUniqueDimension("subject-A")
    );
    expect(pseudonymizeUniqueDimension("subject-A")).not.toBe(
      pseudonymizeUniqueDimension("subject-B")
    );
  });

  test("emits a 64-char lowercase hex digest (satisfies the column length CHECK + domain charset)", () => {
    const digest = pseudonymizeUniqueDimension("user@example.com");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The domain charset gate accepts a hex digest.
    expect(/^[A-Za-z0-9._:@-]{1,200}$/.test(digest)).toBe(true);
  });

  test("is domain-separated: the digest is NOT a bare HMAC of the raw value, and does not collide with the audit ipHash of the same string", () => {
    const raw = "10.0.0.1";
    const bare = createHmac("sha256", SECRET).update(raw).digest("hex");
    // Context prefix on the input means the output differs from an un-prefixed HMAC.
    expect(pseudonymizeUniqueDimension(raw)).not.toBe(bare);
    // And it never equals the audit ipHash (a different-purpose keyed digest).
    expect(hashClientIp(raw)).not.toBe(pseudonymizeUniqueDimension(raw));
  });

  test("fail-closed: throws on a missing or placeholder secret rather than degrading to an unkeyed digest", () => {
    delete process.env.AUTH_JWT_SECRET;
    expect(() => pseudonymizeUniqueDimension("x")).toThrow(/AUTH_JWT_SECRET/);

    const placeholder = findConfigVarEntry("AUTH_JWT_SECRET")?.default;
    if (placeholder !== undefined) {
      process.env.AUTH_JWT_SECRET = placeholder;
      expect(() => pseudonymizeUniqueDimension("x")).toThrow(/placeholder/);
    }
  });
});
