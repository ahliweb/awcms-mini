import test from "node:test";
import assert from "node:assert/strict";

import { resolveTrustedClientIp } from "../../src/security/client-ip.mjs";

test("resolveTrustedClientIp prefers CF-Connecting-IP in cloudflare mode", () => {
  const request = new Request("http://example.test", {
    headers: {
      "cf-connecting-ip": "203.0.113.10",
      "x-forwarded-for": "198.51.100.4, 10.0.0.1",
    },
  });

  assert.equal(resolveTrustedClientIp(request, { trustedProxyMode: "cloudflare" }), "203.0.113.10");
});

test("resolveTrustedClientIp does not trust forwarded headers in direct mode", () => {
  const request = new Request("http://example.test", {
    headers: {
      "x-forwarded-for": "198.51.100.4, 10.0.0.1",
    },
  });

  assert.equal(resolveTrustedClientIp(request, { trustedProxyMode: "direct" }), null);
});

test("resolveTrustedClientIp can read forwarded chain when explicitly enabled", () => {
  const request = new Request("http://example.test", {
    headers: {
      "x-forwarded-for": "198.51.100.4, 10.0.0.1",
    },
  });

  assert.equal(resolveTrustedClientIp(request, { trustedProxyMode: "forwarded-chain" }), "198.51.100.4");
});
