import { describe, expect, test } from "bun:test";

import {
  planVisitorKeyCookie,
  shouldRevokeVisitorKeyCookie
} from "../../src/modules/visitor-analytics/domain/visitor-key-cookie";
import { generateVisitorKey } from "../../src/modules/visitor-analytics/domain/visitor-key";

const VALID_KEY = "550e8400-e29b-41d4-a716-446655440000";

describe("shouldRevokeVisitorKeyCookie (Issue #624 repository audit addendum)", () => {
  test("false when the module is enabled, regardless of existing cookie", () => {
    expect(
      shouldRevokeVisitorKeyCookie({
        config: { enabled: true },
        existingValue: VALID_KEY
      })
    ).toBe(false);
    expect(
      shouldRevokeVisitorKeyCookie({
        config: { enabled: true },
        existingValue: undefined
      })
    ).toBe(false);
  });

  test("false when disabled but no cookie was ever set — nothing to revoke, and no cookie is set either", () => {
    expect(
      shouldRevokeVisitorKeyCookie({
        config: { enabled: false },
        existingValue: undefined
      })
    ).toBe(false);
  });

  test("true when disabled and a (previously valid) cookie is still present — revoke it", () => {
    expect(
      shouldRevokeVisitorKeyCookie({
        config: { enabled: false },
        existingValue: VALID_KEY
      })
    ).toBe(true);
  });

  test("false when disabled and the existing cookie value is forged/invalid — nothing real to revoke", () => {
    expect(
      shouldRevokeVisitorKeyCookie({
        config: { enabled: false },
        existingValue: "<script>alert(1)</script>"
      })
    ).toBe(false);
  });
});

describe("planVisitorKeyCookie (Issue #624 repository audit addendum)", () => {
  test("mints a new key and requests a Set-Cookie when no existing cookie is present", () => {
    const plan = planVisitorKeyCookie({
      config: { visitorKeyCookieTtlDays: 30 },
      existingValue: undefined
    });

    expect(plan.shouldSetCookie).toBe(true);
    expect(plan.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(plan.maxAgeSeconds).toBe(30 * 86_400);
  });

  test("reuses a valid existing cookie without requesting a re-set (no unnecessary Set-Cookie)", () => {
    const plan = planVisitorKeyCookie({
      config: { visitorKeyCookieTtlDays: 30 },
      existingValue: VALID_KEY
    });

    expect(plan.value).toBe(VALID_KEY);
    expect(plan.shouldSetCookie).toBe(false);
  });

  test("rotation: an expired/absent cookie (simulated by the browser having dropped it) yields a fresh key on the next request", () => {
    // A short-lived cookie that already expired in the browser simply
    // isn't sent back — indistinguishable, from this function's point of
    // view, from a first-ever visit. Rotation is therefore just "no
    // existing value", verified above; this test additionally confirms
    // two independent "no existing value" calls each mint a distinct key
    // (no hidden server-side memoization that would defeat rotation).
    const first = planVisitorKeyCookie({
      config: { visitorKeyCookieTtlDays: 30 },
      existingValue: undefined
    });
    const second = planVisitorKeyCookie({
      config: { visitorKeyCookieTtlDays: 30 },
      existingValue: undefined
    });

    expect(first.value).not.toBe(second.value);
  });

  test("mints a fresh key when the existing value is forged/invalid, rather than trusting it", () => {
    const plan = planVisitorKeyCookie({
      config: { visitorKeyCookieTtlDays: 30 },
      existingValue: "<script>alert(1)</script>"
    });

    expect(plan.shouldSetCookie).toBe(true);
    expect(plan.value).not.toBe("<script>alert(1)</script>");
  });

  test("maxAgeSeconds reflects a configurable, shorter-than-2-years TTL", () => {
    const plan = planVisitorKeyCookie({
      config: { visitorKeyCookieTtlDays: 7 },
      existingValue: undefined
    });

    expect(plan.maxAgeSeconds).toBe(7 * 86_400);
    // Sanity check against the previous hardcoded ~2-year constant this
    // replaces (63_072_000 seconds) — the new default must be far shorter.
    expect(plan.maxAgeSeconds).toBeLessThan(63_072_000);
  });

  test("never returns generateVisitorKey's raw output as a magic constant — it is genuinely random per call", () => {
    expect(generateVisitorKey()).not.toBe(generateVisitorKey());
  });
});
