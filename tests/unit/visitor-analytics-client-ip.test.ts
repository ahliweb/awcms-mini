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

  test("trusts a single-value X-Forwarded-For only when trustProxy is true", () => {
    const request = requestWithHeaders({ "x-forwarded-for": "203.0.113.9" });
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: true,
        trustCloudflare: false
      })
    ).toBe("203.0.113.9");
  });

  // Issue #623 acceptance criterion: "If multiple conflicting forwarded
  // values exist, prefer fail-safe behavior... without trusting ambiguous
  // data" — this repo has no "N trusted hops" config to pick the right
  // position from (same reasoning as X-Forwarded-Host in
  // public-host-tenant-resolver.ts), and doc 18's operational contract
  // for a trusted proxy is "overwrite, never append", so a real trusted
  // proxy never produces more than one value here either.
  test("an ambiguous multi-value X-Forwarded-For fails safe (falls back to clientAddress, never trusts any of the values)", () => {
    const request = requestWithHeaders({
      "x-forwarded-for": "203.0.113.9, 10.0.0.1"
    });
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: true,
        trustCloudflare: false
      })
    ).toBe("198.51.100.1");
  });

  test("an ambiguous multi-value CF-Connecting-IP fails safe the same way", () => {
    const request = requestWithHeaders({
      "cf-connecting-ip": "203.0.113.42, 203.0.113.43"
    });
    expect(
      resolveAnalyticsClientIp(request, "198.51.100.1", {
        trustProxy: false,
        trustCloudflare: true
      })
    ).toBe("198.51.100.1");
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
