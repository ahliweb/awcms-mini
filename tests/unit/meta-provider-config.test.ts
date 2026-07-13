import { describe, expect, test } from "bun:test";

import {
  isMetaProviderEnabled,
  loadMetaProviderConfig
} from "../../src/modules/social-publishing/domain/meta-provider-config";

const VALID_ENV = {
  META_PROVIDER_ENABLED: "true",
  META_APP_ID: "1234567890",
  META_APP_SECRET_REFERENCE: "env:META_APP_SECRET",
  META_GRAPH_API_VERSION: "v21.0",
  META_OAUTH_REDIRECT_URI: "https://example.com/auth/meta/callback",
  META_REQUIRED_SCOPES:
    "pages_manage_posts,pages_read_engagement,instagram_content_publish"
} satisfies NodeJS.ProcessEnv;

describe("isMetaProviderEnabled (Issue #644)", () => {
  test("false when unset", () => {
    expect(isMetaProviderEnabled({})).toBe(false);
  });

  test('true only for the literal string "true"', () => {
    expect(isMetaProviderEnabled({ META_PROVIDER_ENABLED: "true" })).toBe(true);
    expect(isMetaProviderEnabled({ META_PROVIDER_ENABLED: "TRUE" })).toBe(
      false
    );
    expect(isMetaProviderEnabled({ META_PROVIDER_ENABLED: "1" })).toBe(false);
  });
});

describe("loadMetaProviderConfig (Issue #644)", () => {
  test('null when META_PROVIDER_ENABLED is not "true" — never crashes a deployment that doesn\'t use Meta', () => {
    expect(loadMetaProviderConfig({})).toBeNull();
    expect(
      loadMetaProviderConfig({ ...VALID_ENV, META_PROVIDER_ENABLED: "false" })
    ).toBeNull();
  });

  test("returns a fully-parsed config for a valid environment", () => {
    const config = loadMetaProviderConfig(VALID_ENV);
    expect(config).not.toBeNull();
    expect(config?.appId).toBe("1234567890");
    expect(config?.appSecretReference).toBe("env:META_APP_SECRET");
    expect(config?.graphApiVersion).toBe("v21.0");
    expect(config?.requiredScopes).toEqual([
      "pages_manage_posts",
      "pages_read_engagement",
      "instagram_content_publish"
    ]);
  });

  test("null when any required variable is missing", () => {
    for (const key of [
      "META_APP_ID",
      "META_APP_SECRET_REFERENCE",
      "META_GRAPH_API_VERSION",
      "META_OAUTH_REDIRECT_URI",
      "META_REQUIRED_SCOPES"
    ] as const) {
      const env = { ...VALID_ENV, [key]: undefined };
      expect(loadMetaProviderConfig(env)).toBeNull();
    }
  });

  test("null when META_GRAPH_API_VERSION doesn't match the expected shape", () => {
    expect(
      loadMetaProviderConfig({
        ...VALID_ENV,
        META_GRAPH_API_VERSION: "21.0"
      })
    ).toBeNull();
    expect(
      loadMetaProviderConfig({
        ...VALID_ENV,
        META_GRAPH_API_VERSION: "latest"
      })
    ).toBeNull();
  });

  test("null when META_OAUTH_REDIRECT_URI is not an absolute HTTPS URL", () => {
    expect(
      loadMetaProviderConfig({
        ...VALID_ENV,
        META_OAUTH_REDIRECT_URI: "http://example.com/callback"
      })
    ).toBeNull();
    expect(
      loadMetaProviderConfig({
        ...VALID_ENV,
        META_OAUTH_REDIRECT_URI: "not-a-url"
      })
    ).toBeNull();
  });

  test("null when META_REQUIRED_SCOPES has no non-empty entries", () => {
    expect(
      loadMetaProviderConfig({ ...VALID_ENV, META_REQUIRED_SCOPES: " , , " })
    ).toBeNull();
  });

  test("deduplicates META_REQUIRED_SCOPES entries", () => {
    const config = loadMetaProviderConfig({
      ...VALID_ENV,
      META_REQUIRED_SCOPES:
        "pages_manage_posts, pages_manage_posts ,pages_read_engagement"
    });
    expect(config?.requiredScopes).toEqual([
      "pages_manage_posts",
      "pages_read_engagement"
    ]);
  });
});
