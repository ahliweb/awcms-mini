/**
 * Issue #821 — unit tests for the audit-safe source fingerprint used by the
 * auth routes' `login_succeeded`/`login_failed`/`mfa_challenge_failed` rows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  hashClientIp,
  summarizeUserAgent
} from "../src/lib/security/client-fingerprint";
import { findConfigVarEntry } from "../src/lib/config/registry";
import { redactSensitiveAttributes } from "../src/modules/_shared/redaction";

const SECRET = "unit-test-ip-hash-secret";

describe("hashClientIp", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.AUTH_JWT_SECRET;
    process.env.AUTH_JWT_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.AUTH_JWT_SECRET;
    } else {
      process.env.AUTH_JWT_SECRET = originalSecret;
    }
  });

  test("is stable for the same address, so audit rows are groupable by source", () => {
    expect(hashClientIp("203.0.113.10")).toBe(hashClientIp("203.0.113.10"));
  });

  test("distinguishes different addresses", () => {
    expect(hashClientIp("203.0.113.10")).not.toBe(hashClientIp("203.0.113.11"));
  });

  test("never contains the address it hashes", () => {
    expect(hashClientIp("203.0.113.10")).not.toContain("203.0.113.10");
    expect(hashClientIp("2001:db8::1")).not.toContain("2001:db8");
  });

  test("is keyed, not a bare digest — a rotated secret changes the output", () => {
    const before = hashClientIp("203.0.113.10");
    process.env.AUTH_JWT_SECRET = "a-different-secret";

    expect(hashClientIp("203.0.113.10")).not.toBe(before);
  });

  test("emits a labelled, fixed-width sha256 hex value", () => {
    expect(hashClientIp("203.0.113.10")).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
  });

  /**
   * PR #839 security review, HIGH 2. This used to be `process.env
   * .AUTH_JWT_SECRET ?? ""` — with the key removed, the HMAC silently
   * degrades to a bare `sha256(ip)` over a 2^32 keyspace, i.e. every audit
   * `ipHash` ever written becomes reversible, with no error anywhere. The
   * variable was simultaneously marked `deprecated` with `removalVersion:
   * "1.0.0"`, so that degradation was actually SCHEDULED. Refusing loudly is
   * the only safe behaviour; the deprecation was lifted in the same change.
   */
  test.each([
    ["unset", undefined],
    ["empty", ""]
  ])(
    "throws rather than degrading to an unkeyed digest (%s)",
    (_label, value) => {
      if (value === undefined) {
        delete process.env.AUTH_JWT_SECRET;
      } else {
        process.env.AUTH_JWT_SECRET = value;
      }

      expect(() => hashClientIp("203.0.113.10")).toThrow(/AUTH_JWT_SECRET/);
    }
  );

  /**
   * The placeholder is non-empty, so it sails past the check above — and
   * `scripts/validate-env.ts`'s `checkAuthJwtSecretNotDefault`, which does
   * catch it, only runs when someone runs `bun run config:validate`. Neither
   * `bun run dev` nor `bun run start` does. A deployment copied from
   * `.env.example` would therefore key this HMAC with a value published in a
   * public repo, making every persisted `ipHash` reversible. (Review finding,
   * PR #839.)
   *
   * The placeholder is read from the registry rather than typed here, so this
   * test cannot drift from the value the code rejects or from `.env.example`.
   */
  test("throws on the documented .env.example placeholder -- it is non-empty, so the unset/empty guard alone lets it through", () => {
    const placeholder = findConfigVarEntry("AUTH_JWT_SECRET")?.default;

    // Guard the guard: if the registry ever stops carrying a default, this
    // test would silently assert nothing.
    expect(typeof placeholder).toBe("string");
    expect(placeholder!.length).toBeGreaterThan(0);

    process.env.AUTH_JWT_SECRET = placeholder!;

    expect(() => hashClientIp("203.0.113.10")).toThrow(/placeholder/i);
  });

  test("a high-entropy secret that merely CONTAINS the placeholder is accepted -- the check is exact-match, not a substring ban", () => {
    const placeholder = findConfigVarEntry("AUTH_JWT_SECRET")?.default;
    process.env.AUTH_JWT_SECRET = `${placeholder}-but-actually-rotated-9f3a2b`;

    expect(() => hashClientIp("203.0.113.10")).not.toThrow();
  });

  /**
   * The whole reason this helper exists: `ip`/`clientIp`/`ipAddress` are
   * redaction keys (Issue #687), so a raw IP under any of those names would be
   * blanked out of the audit trail. `ipHash` must survive the same redactor
   * the audit writer runs — if this ever regresses, every auth audit row
   * silently loses its source attribution.
   */
  test("survives audit redaction under the `ipHash` key", () => {
    const value = hashClientIp("203.0.113.10");
    const redacted = redactSensitiveAttributes({ ipHash: value });

    expect(redacted?.ipHash).toBe(value);
  });

  test("a raw IP under a conventional key would NOT survive — the premise holds", () => {
    const redacted = redactSensitiveAttributes({ clientIp: "203.0.113.10" });

    expect(redacted?.clientIp).toBe("[REDACTED]");
  });
});

describe("summarizeUserAgent", () => {
  function requestWithUserAgent(userAgent?: string): Request {
    return new Request("https://example.test/api/v1/auth/login", {
      headers: userAgent === undefined ? {} : { "user-agent": userAgent }
    });
  }

  test("returns the header value when present", () => {
    expect(summarizeUserAgent(requestWithUserAgent("Mozilla/5.0"))).toBe(
      "Mozilla/5.0"
    );
  });

  test("returns undefined when absent or blank, so the key is omitted", () => {
    expect(summarizeUserAgent(requestWithUserAgent())).toBeUndefined();
    expect(summarizeUserAgent(requestWithUserAgent("   "))).toBeUndefined();
  });

  test("truncates an attacker-sized header before it reaches jsonb", () => {
    const summarized = summarizeUserAgent(
      requestWithUserAgent("A".repeat(10_000))
    );

    expect(summarized).toHaveLength(256);
  });
});
