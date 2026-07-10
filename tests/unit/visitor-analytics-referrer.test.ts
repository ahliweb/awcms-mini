import { describe, expect, test } from "bun:test";

import { extractReferrerDomain } from "../../src/modules/visitor-analytics/domain/referrer";

describe("extractReferrerDomain", () => {
  test("extracts the hostname from a full https URL", () => {
    expect(extractReferrerDomain("https://www.google.com/search?q=awcms")).toBe(
      "www.google.com"
    );
  });

  test("extracts the hostname from a full http URL", () => {
    expect(extractReferrerDomain("http://example.com/some/path")).toBe(
      "example.com"
    );
  });

  test("lowercases the hostname", () => {
    expect(extractReferrerDomain("https://EXAMPLE.com/Path")).toBe(
      "example.com"
    );
  });

  test("never includes the path or query string", () => {
    const result = extractReferrerDomain(
      "https://example.com/secret-path?token=abc123"
    );
    expect(result).toBe("example.com");
    expect(result).not.toContain("secret-path");
    expect(result).not.toContain("abc123");
  });

  test("returns null for missing/empty referrer", () => {
    expect(extractReferrerDomain(null)).toBeNull();
    expect(extractReferrerDomain(undefined)).toBeNull();
    expect(extractReferrerDomain("")).toBeNull();
  });

  test("returns null for a malformed URL", () => {
    expect(extractReferrerDomain("not a url")).toBeNull();
  });

  test("returns null for a non-http(s) scheme", () => {
    expect(extractReferrerDomain("javascript:alert(1)")).toBeNull();
    expect(extractReferrerDomain("data:text/html,<script>")).toBeNull();
  });
});
