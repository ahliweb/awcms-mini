import { describe, expect, test } from "bun:test";

import {
  isFullOnlineSecurityActive,
  isKnownOnlineSecurityProfile,
  isOnlineSecurityEnabled,
  resolveOnlineSecurityProfile
} from "../../src/lib/auth/online-security-config";

describe("isKnownOnlineSecurityProfile", () => {
  test("accepts the two known profiles", () => {
    expect(isKnownOnlineSecurityProfile("disabled")).toBe(true);
    expect(isKnownOnlineSecurityProfile("full_online")).toBe(true);
  });

  test("rejects unknown/undefined values", () => {
    expect(isKnownOnlineSecurityProfile("production")).toBe(false);
    expect(isKnownOnlineSecurityProfile(undefined)).toBe(false);
    expect(isKnownOnlineSecurityProfile("")).toBe(false);
  });
});

describe("isOnlineSecurityEnabled", () => {
  test("false when unset (default, every local/offline/LAN deployment)", () => {
    expect(isOnlineSecurityEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('false for any value other than the literal string "true"', () => {
    expect(
      isOnlineSecurityEnabled({
        AUTH_ONLINE_SECURITY_ENABLED: "false"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      isOnlineSecurityEnabled({
        AUTH_ONLINE_SECURITY_ENABLED: "TRUE"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test('true only for the literal string "true"', () => {
    expect(
      isOnlineSecurityEnabled({
        AUTH_ONLINE_SECURITY_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});

describe("resolveOnlineSecurityProfile", () => {
  test('defaults to "disabled" when unset', () => {
    expect(resolveOnlineSecurityProfile({} as NodeJS.ProcessEnv)).toBe(
      "disabled"
    );
  });

  test('falls back to "disabled" for an unrecognized value — never throws', () => {
    expect(
      resolveOnlineSecurityProfile({
        AUTH_ONLINE_SECURITY_PROFILE: "production"
      } as NodeJS.ProcessEnv)
    ).toBe("disabled");
  });

  test('returns "full_online" when explicitly set', () => {
    expect(
      resolveOnlineSecurityProfile({
        AUTH_ONLINE_SECURITY_PROFILE: "full_online"
      } as NodeJS.ProcessEnv)
    ).toBe("full_online");
  });
});

describe("isFullOnlineSecurityActive — the shared gate #588-#592 must check", () => {
  test("false when unset (default, every local/offline/LAN deployment)", () => {
    expect(isFullOnlineSecurityActive({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('false when enabled but profile is still "disabled" (contradictory config)', () => {
    expect(
      isFullOnlineSecurityActive({
        AUTH_ONLINE_SECURITY_ENABLED: "true",
        AUTH_ONLINE_SECURITY_PROFILE: "disabled"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test('false when profile is full_online but the enable flag is not "true" (profile alone is not enough)', () => {
    expect(
      isFullOnlineSecurityActive({
        AUTH_ONLINE_SECURITY_PROFILE: "full_online"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test("true only when both agree", () => {
    expect(
      isFullOnlineSecurityActive({
        AUTH_ONLINE_SECURITY_ENABLED: "true",
        AUTH_ONLINE_SECURITY_PROFILE: "full_online"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});
