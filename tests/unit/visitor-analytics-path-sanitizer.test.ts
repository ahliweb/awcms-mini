import { describe, expect, test } from "bun:test";

import {
  isTrackablePath,
  sanitizePath
} from "../../src/modules/visitor-analytics/domain/path-sanitizer";

describe("sanitizePath", () => {
  test("leaves a path with no query string unchanged", () => {
    expect(sanitizePath("/news/hello-world")).toBe("/news/hello-world");
  });

  test("keeps a safe, non-sensitive query string intact", () => {
    expect(sanitizePath("/news?utm_source=newsletter&page=2")).toBe(
      "/news?utm_source=newsletter&page=2"
    );
  });

  for (const param of [
    "token",
    "code",
    "password",
    "secret",
    "email",
    "phone",
    "authorization",
    "access_token",
    "refresh_token",
    "reset_token",
    "mfaChallengeToken"
  ]) {
    test(`strips the sensitive query parameter "${param}"`, () => {
      const result = sanitizePath(`/auth/callback?${param}=super-secret-value`);
      expect(result).not.toContain("super-secret-value");
      expect(result).not.toContain(param.toLowerCase());
    });
  }

  test("strips sensitive params case-insensitively", () => {
    const result = sanitizePath("/auth/callback?TOKEN=abc&Password=xyz");
    expect(result).not.toContain("abc");
    expect(result).not.toContain("xyz");
  });

  test("strips sensitive params while keeping other safe params", () => {
    const result = sanitizePath(
      "/auth/reset?reset_token=abc123&utm_source=email"
    );
    expect(result).toBe("/auth/reset?utm_source=email");
  });

  test("returns just the pathname when every query param was sensitive", () => {
    expect(sanitizePath("/auth/callback?token=abc")).toBe("/auth/callback");
  });

  test("never throws on a malformed path", () => {
    expect(() => sanitizePath("not a url at all \0")).not.toThrow();
  });

  // Post-review fix: the first version of the malformed-input fallback
  // returned rawPath unchanged, which could echo an unstrippable
  // sensitive query param verbatim whenever the surrounding string made
  // the whole thing unparseable. It must now fail SAFE (drop the query
  // string entirely), never fail open (echo the raw input).
  for (const malformed of [
    "http://[::1/x?token=SECRET123",
    "http://a:99999999999/x?token=SECRET123",
    "http://a:b:c/x?token=SECRET123",
    "http://%zz/x?token=SECRET123"
  ]) {
    test(`never echoes a sensitive query string on unparseable input: "${malformed}"`, () => {
      expect(sanitizePath(malformed)).not.toContain("SECRET123");
    });
  }
});

describe("isTrackablePath", () => {
  test("a normal content path is trackable", () => {
    expect(isTrackablePath("/news/hello-world")).toBe(true);
    expect(isTrackablePath("/admin/dashboard")).toBe(true);
  });

  test("Astro build assets are not trackable", () => {
    expect(isTrackablePath("/_astro/client.abc123.js")).toBe(false);
  });

  test("favicon is not trackable", () => {
    expect(isTrackablePath("/favicon.ico")).toBe(false);
  });

  for (const extension of [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "webp",
    "avif",
    "ico",
    "css",
    "js",
    "mjs",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "otf",
    "map"
  ]) {
    test(`a static .${extension} asset is not trackable`, () => {
      expect(isTrackablePath(`/assets/file.${extension}`)).toBe(false);
    });
  }

  test("health endpoints are not trackable", () => {
    expect(isTrackablePath("/api/v1/health")).toBe(false);
    expect(isTrackablePath("/api/v1/database/pool/health")).toBe(false);
    expect(isTrackablePath("/api/v1/modules/blog_content/health")).toBe(false);
  });

  test("OpenAPI/AsyncAPI spec paths are not trackable", () => {
    expect(isTrackablePath("/openapi/awcms-mini-public-api.yaml")).toBe(false);
    expect(isTrackablePath("/asyncapi/awcms-mini-domain-events.yaml")).toBe(
      false
    );
  });

  test("a path that merely contains a query string is still evaluated on its pathname", () => {
    expect(isTrackablePath("/news/hello-world?utm_source=x")).toBe(true);
    expect(isTrackablePath("/assets/file.css?v=2")).toBe(false);
  });
});
