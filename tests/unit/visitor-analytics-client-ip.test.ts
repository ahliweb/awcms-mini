import { describe, expect, test } from "bun:test";

import { resolveAnalyticsClientIp } from "../../src/modules/visitor-analytics/domain/client-ip";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://internal.invalid/", { headers });
}

describe("resolveAnalyticsClientIp", () => {
  test("uses clientAddress when no trust flags are enabled, ignoring forwarded headers", () => {
    const request = requestWithHeaders({ "x-forwarded-for": "203.0.113.9" });
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: false,
        trustCloudflare: false
      })
    ).toBe("198.51.100.1");
  });

  test("trusts X-Forwarded-For only when trustProxy is true", () => {
    const request = requestWithHeaders({
      "x-forwarded-for": "203.0.113.9, 10.0.0.1"
    });
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: true,
        trustCloudflare: false
      })
    ).toBe("203.0.113.9");
  });

  test("trusts CF-Connecting-IP only when trustCloudflare is true, taking priority over X-Forwarded-For", () => {
    const request = requestWithHeaders({
      "cf-connecting-ip": "203.0.113.42",
      "x-forwarded-for": "203.0.113.9"
    });
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: true,
        trustCloudflare: true
      })
    ).toBe("203.0.113.42");
  });

  test("falls back to clientAddress when trustProxy is true but no header is present", () => {
    const request = requestWithHeaders({});
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: true,
        trustCloudflare: false
      })
    ).toBe("198.51.100.1");
  });

  test("returns null (never a fake placeholder) when nothing is resolvable", () => {
    const request = requestWithHeaders({});
    expect(
      resolveAnalyticsClientIp(request, undefined, {
        trustProxy: false,
        trustCloudflare: false
      })
    ).toBeNull();
  });

  test("never trusts a spoofed forwarded header without explicit opt-in", () => {
    const request = requestWithHeaders({
      "cf-connecting-ip": "203.0.113.42",
      "x-forwarded-for": "203.0.113.9"
    });
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: false,
        trustCloudflare: false
      })
    ).toBe("198.51.100.1");
  });
});
