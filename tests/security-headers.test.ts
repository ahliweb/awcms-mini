import { describe, expect, test } from "bun:test";

import { buildSecurityHeaders } from "../src/lib/security/security-headers";

// Content-Security-Policy is deliberately NOT tested here — it isn't built
// by this module. It's Astro's own `security.csp` feature
// (`astro.config.mjs`), which sets its own `Content-Security-Policy`
// response header for this SSR build, computed from whatever Astro
// actually inlines. See that config's comment and
// `src/lib/security/security-headers.ts`'s module doc for why a hand-rolled
// nonce/hash was tried first and abandoned (a real headless-Chrome check —
// not just curl — caught it silently breaking several admin-page inline
// scripts/styles a hand-rolled allowlist didn't know about). CSP is instead
// verified live via `bun run build && bun ./dist/server/entry.mjs` + a
// headless-Chrome/CDP session (see PR description / audit doc for the
// captured console output, before vs. after).

describe("buildSecurityHeaders", () => {
  test("always includes the baseline hardening headers", () => {
    const headers = buildSecurityHeaders({ isProduction: false });
    const map = new Map(headers);

    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map.get("Permissions-Policy")).toContain("geolocation=()");
  });

  test("does not set Content-Security-Policy (that's Astro's own security.csp)", () => {
    const headers = buildSecurityHeaders({ isProduction: false });
    const map = new Map(headers);

    expect(map.has("Content-Security-Policy")).toBe(false);
  });

  test("omits Strict-Transport-Security outside production", () => {
    const headers = buildSecurityHeaders({ isProduction: false });
    const map = new Map(headers);

    expect(map.has("Strict-Transport-Security")).toBe(false);
  });

  test("adds Strict-Transport-Security in production", () => {
    const headers = buildSecurityHeaders({ isProduction: true });
    const map = new Map(headers);

    expect(map.get("Strict-Transport-Security")).toContain("max-age=");
    expect(map.get("Strict-Transport-Security")).toContain("includeSubDomains");
  });
});
