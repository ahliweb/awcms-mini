import { describe, expect, test } from "bun:test";

import {
  isSsoEnabled,
  isSsoRequired,
  resolveSsoDiscoveryTimeoutMs,
  resolveSsoMaxProvidersPerTenant,
  resolveSsoRedirectUri
} from "../../src/lib/auth/sso-config";

describe("sso-config (Issue #591)", () => {
  test("isSsoEnabled is false when unset", () => {
    expect(isSsoEnabled({})).toBe(false);
  });

  test("isSsoEnabled is true only for the literal string 'true'", () => {
    expect(isSsoEnabled({ AUTH_SSO_ENABLED: "true" })).toBe(true);
    expect(isSsoEnabled({ AUTH_SSO_ENABLED: "yes" })).toBe(false);
  });

  test("isSsoRequired is false when the full-online gate is off, even with AUTH_SSO_ENABLED=true", () => {
    expect(
      isSsoRequired({
        AUTH_SSO_ENABLED: "true",
        AUTH_ONLINE_SECURITY_ENABLED: "false"
      })
    ).toBe(false);
  });

  test("isSsoRequired is false when AUTH_SSO_ENABLED is not true, even with the gate active", () => {
    expect(
      isSsoRequired({
        AUTH_ONLINE_SECURITY_ENABLED: "true",
        AUTH_ONLINE_SECURITY_PROFILE: "full_online"
      })
    ).toBe(false);
  });

  test("isSsoRequired is true only when both agree", () => {
    expect(
      isSsoRequired({
        AUTH_ONLINE_SECURITY_ENABLED: "true",
        AUTH_ONLINE_SECURITY_PROFILE: "full_online",
        AUTH_SSO_ENABLED: "true"
      })
    ).toBe(true);
  });

  test("resolveSsoDiscoveryTimeoutMs falls back to 5000ms for unset/invalid values", () => {
    expect(resolveSsoDiscoveryTimeoutMs({})).toBe(5000);
    expect(
      resolveSsoDiscoveryTimeoutMs({ AUTH_SSO_DISCOVERY_TIMEOUT_MS: "abc" })
    ).toBe(5000);
    expect(
      resolveSsoDiscoveryTimeoutMs({ AUTH_SSO_DISCOVERY_TIMEOUT_MS: "-5" })
    ).toBe(5000);
  });

  test("resolveSsoDiscoveryTimeoutMs honors a valid positive override", () => {
    expect(
      resolveSsoDiscoveryTimeoutMs({ AUTH_SSO_DISCOVERY_TIMEOUT_MS: "8000" })
    ).toBe(8000);
  });

  test("resolveSsoMaxProvidersPerTenant falls back to 20 for unset/invalid values", () => {
    expect(resolveSsoMaxProvidersPerTenant({})).toBe(20);
    expect(
      resolveSsoMaxProvidersPerTenant({
        AUTH_SSO_MAX_PROVIDERS_PER_TENANT: "abc"
      })
    ).toBe(20);
    expect(
      resolveSsoMaxProvidersPerTenant({
        AUTH_SSO_MAX_PROVIDERS_PER_TENANT: "0"
      })
    ).toBe(20);
    expect(
      resolveSsoMaxProvidersPerTenant({
        AUTH_SSO_MAX_PROVIDERS_PER_TENANT: "-5"
      })
    ).toBe(20);
  });

  test("resolveSsoMaxProvidersPerTenant honors a valid positive override, floored to an integer", () => {
    expect(
      resolveSsoMaxProvidersPerTenant({
        AUTH_SSO_MAX_PROVIDERS_PER_TENANT: "5"
      })
    ).toBe(5);
    expect(
      resolveSsoMaxProvidersPerTenant({
        AUTH_SSO_MAX_PROVIDERS_PER_TENANT: "5.9"
      })
    ).toBe(5);
  });

  test("resolveSsoRedirectUri builds a deployment-owned callback path per provider key, never client-supplied", () => {
    const url = resolveSsoRedirectUri("okta", {
      APP_URL: "https://app.example.com"
    });
    expect(url).toBe("https://app.example.com/api/v1/auth/sso/okta/callback");
  });
});
