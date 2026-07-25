/**
 * Unit tests for the application half of the edge cache
 * (`src/lib/http/cache-policy.ts`).
 *
 * The edge caches only what this module marks, so these assertions are the
 * upstream half of the isolation `bun run varnish:cache:check` proves at the
 * HTTP level. The properties that matter are the negative ones: a response
 * nobody thought about must end up `no-store`, and a response that establishes
 * identity must end up `no-store` even when a route explicitly asked for it to
 * be cached.
 */
import { describe, expect, test } from "bun:test";

import {
  applyCachePolicy,
  cachePolicyHeaders,
  EDGE_CACHE_HEADER,
  ensureDefaultCachePolicy,
  MAX_EDGE_MAX_AGE_SECONDS,
  MAX_PUBLIC_MAX_AGE_SECONDS
} from "../../src/lib/http/cache-policy";

describe("cachePolicyHeaders", () => {
  test("no-store carries no edge opt-in", () => {
    const headers = cachePolicyHeaders({ kind: "no-store" });
    expect(headers.cacheControl).toBe("private, no-store");
    expect(headers.edgeCache).toBeUndefined();
  });

  test("public is shareable by every cache, with no private edge header", () => {
    const headers = cachePolicyHeaders({ kind: "public", maxAgeSeconds: 60 });
    expect(headers.cacheControl).toBe("public, max-age=60");
    expect(headers.edgeCache).toBeUndefined();
  });

  test("session tells every generic cache no-store and only our edge otherwise", () => {
    // This combination is the whole design. `private, max-age=N` would have
    // permitted a browser or a loosely-behaved proxy to retain an
    // authenticated page; the edge header is understood only by our Varnish,
    // which strips it before delivery.
    const headers = cachePolicyHeaders({ kind: "session", maxAgeSeconds: 30 });
    expect(headers.cacheControl).toBe("private, no-store");
    expect(headers.edgeCache).toBe("session; max-age=30");
  });

  test("TTLs are clamped, not honoured, when a caller asks for too long", () => {
    // A stale AUTHORIZED page outlives a revoked role, so the session ceiling
    // is the tighter of the two by design.
    expect(
      cachePolicyHeaders({ kind: "session", maxAgeSeconds: 86_400 }).edgeCache
    ).toBe(`session; max-age=${MAX_EDGE_MAX_AGE_SECONDS}`);
    expect(
      cachePolicyHeaders({ kind: "public", maxAgeSeconds: 86_400 }).cacheControl
    ).toBe(`public, max-age=${MAX_PUBLIC_MAX_AGE_SECONDS}`);
    expect(MAX_EDGE_MAX_AGE_SECONDS).toBeLessThan(MAX_PUBLIC_MAX_AGE_SECONDS);
  });

  test("a zero or nonsensical TTL degrades to no-store rather than to a default", () => {
    for (const maxAgeSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        cachePolicyHeaders({ kind: "session", maxAgeSeconds }).cacheControl
      ).toBe("private, no-store");
      expect(
        cachePolicyHeaders({ kind: "public", maxAgeSeconds }).cacheControl
      ).toBe("private, no-store");
    }
  });
});

describe("applyCachePolicy", () => {
  test("tightening a previously cacheable response clears the edge opt-in", () => {
    const response = new Response("x");
    applyCachePolicy(response, { kind: "session", maxAgeSeconds: 30 });
    expect(response.headers.get(EDGE_CACHE_HEADER)).toBe("session; max-age=30");

    applyCachePolicy(response, { kind: "no-store" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    // A leftover edge header would keep the edge caching a response the route
    // has since decided is private.
    expect(response.headers.has(EDGE_CACHE_HEADER)).toBe(false);
  });
});

describe("ensureDefaultCachePolicy", () => {
  test("a response nobody thought about becomes no-store", () => {
    const response = new Response("x");
    expect(response.headers.has("Cache-Control")).toBe(false);
    ensureDefaultCachePolicy(response);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("an explicit policy is left alone", () => {
    const response = new Response("x");
    applyCachePolicy(response, { kind: "public", maxAgeSeconds: 60 });
    ensureDefaultCachePolicy(response);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  test("Set-Cookie forces no-store even when the route asked to be cached", () => {
    // The one case where an explicit request is overridden. A cached
    // Set-Cookie hands one visitor's session, locale, or tenant selection to
    // the next, and no route has a legitimate reason to want that.
    const response = new Response("x");
    applyCachePolicy(response, { kind: "session", maxAgeSeconds: 30 });
    response.headers.set("Set-Cookie", "awcms_mini_session=abc; Path=/");

    ensureDefaultCachePolicy(response);

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.has(EDGE_CACHE_HEADER)).toBe(false);
  });

  test("Set-Cookie also overrides a public policy", () => {
    const response = new Response("x");
    applyCachePolicy(response, { kind: "public", maxAgeSeconds: 60 });
    response.headers.set("Set-Cookie", "awcms_mini_locale=id; Path=/");

    ensureDefaultCachePolicy(response);

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
