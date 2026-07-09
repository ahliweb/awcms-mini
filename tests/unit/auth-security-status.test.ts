import { describe, expect, test } from "bun:test";

import { resolveAuthSecurityStatusSummary } from "../../src/lib/auth/auth-security-status";

const GATE_ON = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online"
};

describe("auth-security-status (Issue #592)", () => {
  test("every deployment default (all env unset) reports the gate off and every feature disabled/unconfigured", () => {
    const summary = resolveAuthSecurityStatusSummary({});

    expect(summary.gateEnabled).toBe(false);
    expect(summary.gateProfile).toBe("disabled");
    expect(summary.gateActive).toBe(false);
    expect(summary.turnstile).toEqual({ enabled: false, configured: false });
    expect(summary.mfa).toEqual({ enabled: false, configured: false });
    expect(summary.googleLogin).toEqual({ enabled: false, configured: false });
    expect(summary.sso).toEqual({ enabled: false, configured: false });
  });

  test("gateActive requires BOTH AUTH_ONLINE_SECURITY_ENABLED=true AND profile=full_online", () => {
    expect(
      resolveAuthSecurityStatusSummary({
        AUTH_ONLINE_SECURITY_ENABLED: "true"
      }).gateActive
    ).toBe(false);

    expect(resolveAuthSecurityStatusSummary(GATE_ON).gateActive).toBe(true);
  });

  test("a feature's own *_ENABLED flag is independent of the shared gate — reported even when the gate is off (so an admin can see it was flipped on prematurely)", () => {
    const summary = resolveAuthSecurityStatusSummary({
      TURNSTILE_ENABLED: "true"
    });

    expect(summary.gateActive).toBe(false);
    expect(summary.turnstile.enabled).toBe(true);
  });

  test("turnstile.configured is true only once BOTH TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are present", () => {
    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        TURNSTILE_ENABLED: "true",
        TURNSTILE_SITE_KEY: "site-key"
      }).turnstile.configured
    ).toBe(false);

    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        TURNSTILE_ENABLED: "true",
        TURNSTILE_SITE_KEY: "site-key",
        TURNSTILE_SECRET_KEY: "secret-key"
      }).turnstile.configured
    ).toBe(true);
  });

  test("mfa.configured requires AUTH_MFA_SECRET_ENCRYPTION_KEY", () => {
    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        AUTH_MFA_ENABLED: "true"
      }).mfa.configured
    ).toBe(false);

    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        AUTH_MFA_ENABLED: "true",
        AUTH_MFA_SECRET_ENCRYPTION_KEY: "a".repeat(32)
      }).mfa.configured
    ).toBe(true);
  });

  test("googleLogin.configured requires both AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET", () => {
    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        AUTH_GOOGLE_LOGIN_ENABLED: "true",
        AUTH_GOOGLE_CLIENT_ID: "client-id"
      }).googleLogin.configured
    ).toBe(false);

    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        AUTH_GOOGLE_LOGIN_ENABLED: "true",
        AUTH_GOOGLE_CLIENT_ID: "client-id",
        AUTH_GOOGLE_CLIENT_SECRET: "client-secret"
      }).googleLogin.configured
    ).toBe(true);
  });

  test("sso.configured requires AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY", () => {
    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        AUTH_SSO_ENABLED: "true"
      }).sso.configured
    ).toBe(false);

    expect(
      resolveAuthSecurityStatusSummary({
        ...GATE_ON,
        AUTH_SSO_ENABLED: "true",
        AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(32)
      }).sso.configured
    ).toBe(true);
  });

  test("never throws for a completely empty env object", () => {
    expect(() => resolveAuthSecurityStatusSummary({})).not.toThrow();
  });
});
