import { describe, expect, test } from "bun:test";

import {
  checkRateLimit,
  resolveClientIp
} from "../src/lib/security/rate-limit";

describe("checkRateLimit", () => {
  test("allows the first maxAttempts calls within the window", () => {
    const key = `test-allow-${crypto.randomUUID()}`;
    const config = { maxAttempts: 3, windowMs: 60_000 };
    const now = 1_000_000;

    expect(checkRateLimit(key, config, now).allowed).toBe(true);
    expect(checkRateLimit(key, config, now + 1).allowed).toBe(true);
    expect(checkRateLimit(key, config, now + 2).allowed).toBe(true);
  });

  test("denies the (maxAttempts + 1)th call within the same window", () => {
    const key = `test-deny-${crypto.randomUUID()}`;
    const config = { maxAttempts: 3, windowMs: 60_000 };
    const now = 1_000_000;

    checkRateLimit(key, config, now);
    checkRateLimit(key, config, now + 1);
    checkRateLimit(key, config, now + 2);
    const fourth = checkRateLimit(key, config, now + 3);

    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      expect(fourth.retryAfterSec).toBeGreaterThan(0);
    }
  });

  test("resets after the window elapses", () => {
    const key = `test-reset-${crypto.randomUUID()}`;
    const config = { maxAttempts: 1, windowMs: 1_000 };
    const now = 1_000_000;

    expect(checkRateLimit(key, config, now).allowed).toBe(true);
    expect(checkRateLimit(key, config, now + 500).allowed).toBe(false);
    // Window has fully elapsed -> a fresh window starts, allowed again.
    expect(checkRateLimit(key, config, now + 1_001).allowed).toBe(true);
  });

  test("tracks independent keys independently", () => {
    const keyA = `test-independent-a-${crypto.randomUUID()}`;
    const keyB = `test-independent-b-${crypto.randomUUID()}`;
    const config = { maxAttempts: 1, windowMs: 60_000 };
    const now = 1_000_000;

    checkRateLimit(keyA, config, now);
    const secondForA = checkRateLimit(keyA, config, now + 1);
    const firstForB = checkRateLimit(keyB, config, now + 1);

    expect(secondForA.allowed).toBe(false);
    expect(firstForB.allowed).toBe(true);
  });
});

describe("resolveClientIp", () => {
  test("prefers the first entry of X-Forwarded-For", () => {
    const request = new Request("http://example.test/", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" }
    });

    expect(resolveClientIp(request, "10.0.0.2")).toBe("203.0.113.5");
  });

  test("falls back to clientAddress when there is no X-Forwarded-For", () => {
    const request = new Request("http://example.test/");

    expect(resolveClientIp(request, "10.0.0.2")).toBe("10.0.0.2");
  });

  test("falls back to a placeholder when neither is available", () => {
    const request = new Request("http://example.test/");

    expect(resolveClientIp(request, undefined)).toBe("unknown");
  });
});
