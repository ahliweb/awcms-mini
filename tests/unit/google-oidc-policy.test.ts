import { describe, expect, test } from "bun:test";

import {
  evaluateOAuthRequest,
  isEmailDomainAllowed,
  validateIdTokenClaims
} from "../../src/modules/identity-access/domain/google-oidc-policy";

const NOW = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date(NOW.getTime() + 60_000);
const PAST = new Date(NOW.getTime() - 60_000);

describe("evaluateOAuthRequest", () => {
  test("invalid: not_found when there is no row", () => {
    expect(evaluateOAuthRequest(null, NOW)).toEqual({
      outcome: "invalid",
      reason: "not_found"
    });
  });

  test("invalid: already_used when consumedAt is set", () => {
    const result = evaluateOAuthRequest(
      { expiresAt: FUTURE, consumedAt: PAST },
      NOW
    );
    expect(result).toEqual({ outcome: "invalid", reason: "already_used" });
  });

  test("invalid: expired when expiresAt is in the past", () => {
    const result = evaluateOAuthRequest(
      { expiresAt: PAST, consumedAt: null },
      NOW
    );
    expect(result).toEqual({ outcome: "invalid", reason: "expired" });
  });

  test("valid when none of the deny conditions apply", () => {
    const result = evaluateOAuthRequest(
      { expiresAt: FUTURE, consumedAt: null },
      NOW
    );
    expect(result).toEqual({ outcome: "valid" });
  });

  test("already_used takes priority over expired", () => {
    const result = evaluateOAuthRequest(
      { expiresAt: PAST, consumedAt: PAST },
      NOW
    );
    expect(result).toEqual({ outcome: "invalid", reason: "already_used" });
  });
});

const BASE_OPTIONS = {
  expectedIssuers: ["https://accounts.google.com", "accounts.google.com"],
  expectedAudience: "client-abc",
  expectedNonce: "nonce-123",
  nowSec: 1_700_000_000
};

describe("validateIdTokenClaims", () => {
  test("valid: all claims correct", () => {
    const result = validateIdTokenClaims(
      {
        sub: "user-123",
        iss: "https://accounts.google.com",
        aud: "client-abc",
        exp: BASE_OPTIONS.nowSec + 3600,
        nonce: "nonce-123"
      },
      BASE_OPTIONS
    );
    expect(result).toEqual({ outcome: "valid", subject: "user-123" });
  });

  test("accepts the alternate issuer form", () => {
    const result = validateIdTokenClaims(
      {
        sub: "user-123",
        iss: "accounts.google.com",
        aud: "client-abc",
        exp: BASE_OPTIONS.nowSec + 3600,
        nonce: "nonce-123"
      },
      BASE_OPTIONS
    );
    expect(result.outcome).toBe("valid");
  });

  test("invalid: missing_subject when sub is absent or empty", () => {
    expect(
      validateIdTokenClaims(
        {
          iss: "https://accounts.google.com",
          aud: "client-abc",
          exp: BASE_OPTIONS.nowSec + 3600,
          nonce: "nonce-123"
        },
        BASE_OPTIONS
      )
    ).toEqual({ outcome: "invalid", reason: "missing_subject" });
  });

  test("invalid: issuer_mismatch for an unrecognized issuer", () => {
    expect(
      validateIdTokenClaims(
        {
          sub: "user-123",
          iss: "https://evil.example.com",
          aud: "client-abc",
          exp: BASE_OPTIONS.nowSec + 3600,
          nonce: "nonce-123"
        },
        BASE_OPTIONS
      )
    ).toEqual({ outcome: "invalid", reason: "issuer_mismatch" });
  });

  test("invalid: audience_mismatch when aud doesn't match our client id", () => {
    expect(
      validateIdTokenClaims(
        {
          sub: "user-123",
          iss: "https://accounts.google.com",
          aud: "someone-elses-client-id",
          exp: BASE_OPTIONS.nowSec + 3600,
          nonce: "nonce-123"
        },
        BASE_OPTIONS
      )
    ).toEqual({ outcome: "invalid", reason: "audience_mismatch" });
  });

  test("invalid: expired when exp is in the past", () => {
    expect(
      validateIdTokenClaims(
        {
          sub: "user-123",
          iss: "https://accounts.google.com",
          aud: "client-abc",
          exp: BASE_OPTIONS.nowSec - 1,
          nonce: "nonce-123"
        },
        BASE_OPTIONS
      )
    ).toEqual({ outcome: "invalid", reason: "expired" });
  });

  test("invalid: nonce_mismatch when nonce doesn't match the stored request", () => {
    expect(
      validateIdTokenClaims(
        {
          sub: "user-123",
          iss: "https://accounts.google.com",
          aud: "client-abc",
          exp: BASE_OPTIONS.nowSec + 3600,
          nonce: "wrong-nonce"
        },
        BASE_OPTIONS
      )
    ).toEqual({ outcome: "invalid", reason: "nonce_mismatch" });
  });
});

describe("isEmailDomainAllowed", () => {
  test("fails closed when allowedDomains is empty (the default, unset config)", () => {
    expect(isEmailDomainAllowed("user@example.com", [])).toBe(false);
  });

  test("true when the email's domain is in the list", () => {
    expect(
      isEmailDomainAllowed("user@example.com", ["example.com", "other.org"])
    ).toBe(true);
  });

  test("false when the domain isn't in the list", () => {
    expect(isEmailDomainAllowed("user@evil.com", ["example.com"])).toBe(false);
  });

  test("comparison is case-insensitive on the domain", () => {
    expect(isEmailDomainAllowed("user@Example.COM", ["example.com"])).toBe(
      true
    );
  });

  test("false for a malformed email with no @", () => {
    expect(isEmailDomainAllowed("not-an-email", ["example.com"])).toBe(false);
  });
});
