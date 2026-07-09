import { describe, expect, test } from "bun:test";

import {
  isGoogleLoginEnabled,
  isGoogleLoginRequired,
  resolveGoogleAllowedDomains,
  resolveGoogleClientId,
  resolveGoogleClientSecret,
  resolveGoogleRedirectPath
} from "../../src/lib/auth/google-oidc-config";

const FULL_ONLINE_ENV = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online"
} as const;

describe("isGoogleLoginEnabled", () => {
  test("false when unset", () => {
    expect(isGoogleLoginEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('true only for the literal string "true"', () => {
    expect(
      isGoogleLoginEnabled({
        AUTH_GOOGLE_LOGIN_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      isGoogleLoginEnabled({
        AUTH_GOOGLE_LOGIN_ENABLED: "TRUE"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("isGoogleLoginRequired — the shared gate login/callback/link/unlink all check", () => {
  test("false when the full-online gate (#587) is off, even if AUTH_GOOGLE_LOGIN_ENABLED=true", () => {
    expect(
      isGoogleLoginRequired({
        AUTH_GOOGLE_LOGIN_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test("false when AUTH_GOOGLE_LOGIN_ENABLED is not set, even if the full-online gate is on", () => {
    expect(
      isGoogleLoginRequired({ ...FULL_ONLINE_ENV } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test("true only when both the full-online gate and AUTH_GOOGLE_LOGIN_ENABLED agree", () => {
    expect(
      isGoogleLoginRequired({
        ...FULL_ONLINE_ENV,
        AUTH_GOOGLE_LOGIN_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});

describe("resolveGoogleClientId/resolveGoogleClientSecret", () => {
  test("returns undefined when unset", () => {
    expect(resolveGoogleClientId({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveGoogleClientSecret({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test("returns the configured value", () => {
    expect(
      resolveGoogleClientId({
        AUTH_GOOGLE_CLIENT_ID: "client-abc"
      } as NodeJS.ProcessEnv)
    ).toBe("client-abc");
    expect(
      resolveGoogleClientSecret({
        AUTH_GOOGLE_CLIENT_SECRET: "secret-abc"
      } as NodeJS.ProcessEnv)
    ).toBe("secret-abc");
  });
});

describe("resolveGoogleAllowedDomains", () => {
  test("empty array when unset — auto-linking-by-email is fail-closed", () => {
    expect(resolveGoogleAllowedDomains({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  test("parses a comma-separated list, trimmed and lowercased", () => {
    expect(
      resolveGoogleAllowedDomains({
        AUTH_GOOGLE_ALLOWED_DOMAINS: " Example.com, other.ORG ,"
      } as NodeJS.ProcessEnv)
    ).toEqual(["example.com", "other.org"]);
  });

  test("drops empty entries from stray commas", () => {
    expect(
      resolveGoogleAllowedDomains({
        AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com,,other.org"
      } as NodeJS.ProcessEnv)
    ).toEqual(["example.com", "other.org"]);
  });
});

describe("resolveGoogleRedirectPath", () => {
  test("defaults to the standard callback path", () => {
    expect(resolveGoogleRedirectPath({} as NodeJS.ProcessEnv)).toBe(
      "/api/v1/auth/providers/google/callback"
    );
  });

  test("uses a trimmed override", () => {
    expect(
      resolveGoogleRedirectPath({
        AUTH_GOOGLE_REDIRECT_PATH: "  /custom/callback  "
      } as NodeJS.ProcessEnv)
    ).toBe("/custom/callback");
  });

  test("falls back to the default for an empty/whitespace-only override", () => {
    expect(
      resolveGoogleRedirectPath({
        AUTH_GOOGLE_REDIRECT_PATH: "   "
      } as NodeJS.ProcessEnv)
    ).toBe("/api/v1/auth/providers/google/callback");
  });
});
