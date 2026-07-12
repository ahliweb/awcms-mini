import { describe, expect, test } from "bun:test";

import { normalizeMetaGraphApiError } from "../../src/modules/social-publishing/domain/meta-error-normalization";

describe("normalizeMetaGraphApiError (Issue #644)", () => {
  test("OAuthException (code 190) normalizes to needs_reauth, not retryable, safe fixed message", () => {
    const result = normalizeMetaGraphApiError(401, {
      error: {
        message: "Error validating access token: Session has expired.",
        type: "OAuthException",
        code: 190,
        fbtrace_id: "AbCdEfGhIjK"
      }
    });
    expect(result).toEqual({
      outcome: "needs_reauth",
      errorCode: "meta_oauth_exception_190",
      errorMessage: expect.any(String),
      retryable: false
    });
    // Never leaks Meta's own message text or fbtrace_id.
    expect(JSON.stringify(result)).not.toContain("Session has expired");
    expect(JSON.stringify(result)).not.toContain("AbCdEfGhIjK");
  });

  test("permission error codes normalize to needs_reauth", () => {
    for (const code of [10, 200]) {
      const result = normalizeMetaGraphApiError(403, {
        error: { message: "(#10) Permission denied", code }
      });
      expect(result.outcome).toBe("needs_reauth");
      expect(result.errorCode).toBe(`meta_permission_error_${code}`);
      expect(result.retryable).toBe(false);
    }
  });

  test("rate limit error codes normalize to rate_limited with a retryAfterSeconds hint", () => {
    for (const code of [4, 17, 32, 613]) {
      const result = normalizeMetaGraphApiError(400, {
        error: { message: "Rate limited", code }
      });
      expect(result.outcome).toBe("rate_limited");
      if (result.outcome === "rate_limited") {
        expect(result.retryable).toBe(true);
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
      }
    }
  });

  test("HTTP 429 with no recognizable Meta error shape still normalizes to rate_limited", () => {
    const result = normalizeMetaGraphApiError(429, {});
    expect(result.outcome).toBe("rate_limited");
  });

  test("HTTP 5xx with no recognizable Meta error shape normalizes to a retryable failed", () => {
    const result = normalizeMetaGraphApiError(503, "Service Unavailable");
    expect(result).toEqual({
      outcome: "failed",
      errorCode: "meta_server_error",
      errorMessage: expect.any(String),
      retryable: true
    });
  });

  test("an unrecognized 4xx error normalizes to a non-retryable failed, keyed by code", () => {
    const result = normalizeMetaGraphApiError(400, {
      error: { message: "Invalid parameter", code: 100 }
    });
    expect(result).toEqual({
      outcome: "failed",
      errorCode: "meta_api_error_100",
      errorMessage: expect.any(String),
      retryable: false
    });
  });

  test("a body with no recognizable error shape at all never throws", () => {
    expect(() => normalizeMetaGraphApiError(400, null)).not.toThrow();
    expect(() => normalizeMetaGraphApiError(400, "plain text")).not.toThrow();
    expect(() => normalizeMetaGraphApiError(400, { foo: "bar" })).not.toThrow();
  });
});
