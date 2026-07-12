import { describe, expect, test } from "bun:test";

import {
  isKnownVisitorAnalyticsMode,
  isVisitorAnalyticsEnabled,
  parsePositiveInt,
  resolveVisitorAnalyticsConfig,
  resolveVisitorKeyCookieMaxAgeSeconds,
  VISITOR_ANALYTICS_DEFAULTS,
  VISITOR_ANALYTICS_MODES
} from "../../src/modules/visitor-analytics/domain/visitor-analytics-config";

describe("isKnownVisitorAnalyticsMode", () => {
  test("accepts the two known modes", () => {
    expect(isKnownVisitorAnalyticsMode("basic")).toBe(true);
    expect(isKnownVisitorAnalyticsMode("detailed")).toBe(true);
  });

  test("rejects unknown/undefined values", () => {
    expect(isKnownVisitorAnalyticsMode("full")).toBe(false);
    expect(isKnownVisitorAnalyticsMode(undefined)).toBe(false);
    expect(isKnownVisitorAnalyticsMode("")).toBe(false);
  });
});

describe("parsePositiveInt", () => {
  test("undefined for unset/blank", () => {
    expect(parsePositiveInt(undefined)).toBeUndefined();
    expect(parsePositiveInt("")).toBeUndefined();
    expect(parsePositiveInt("   ")).toBeUndefined();
  });

  test("undefined for non-numeric, negative, zero, or float values", () => {
    expect(parsePositiveInt("abc")).toBeUndefined();
    expect(parsePositiveInt("-5")).toBeUndefined();
    expect(parsePositiveInt("0")).toBeUndefined();
    expect(parsePositiveInt("1.5")).toBeUndefined();
  });

  test("parses a valid positive integer", () => {
    expect(parsePositiveInt("300")).toBe(300);
    expect(parsePositiveInt("1")).toBe(1);
  });
});

describe("resolveVisitorAnalyticsConfig", () => {
  test("returns VISITOR_ANALYTICS_DEFAULTS when env is empty (privacy-first default)", () => {
    expect(resolveVisitorAnalyticsConfig({} as NodeJS.ProcessEnv)).toEqual(
      VISITOR_ANALYTICS_DEFAULTS
    );
  });

  test("raw IP, raw user-agent, and geolocation stay off unless explicitly opted in", () => {
    const config = resolveVisitorAnalyticsConfig({
      VISITOR_ANALYTICS_MODE: "detailed"
    } as NodeJS.ProcessEnv);

    expect(config.mode).toBe("detailed");
    expect(config.rawIpEnabled).toBe(false);
    expect(config.rawUserAgentEnabled).toBe(false);
    expect(config.geoEnabled).toBe(false);
  });

  test("falls back to basic mode for an unrecognized VISITOR_ANALYTICS_MODE — never throws", () => {
    expect(
      resolveVisitorAnalyticsConfig({
        VISITOR_ANALYTICS_MODE: "full"
      } as NodeJS.ProcessEnv).mode
    ).toBe("basic");
  });

  test("falls back to the default retention/window values for malformed integers", () => {
    const config = resolveVisitorAnalyticsConfig({
      VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS: "not-a-number",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "-1",
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "0"
    } as NodeJS.ProcessEnv);

    expect(config.onlineWindowSeconds).toBe(
      VISITOR_ANALYTICS_DEFAULTS.onlineWindowSeconds
    );
    expect(config.eventRetentionDays).toBe(
      VISITOR_ANALYTICS_DEFAULTS.eventRetentionDays
    );
    expect(config.rawDetailRetentionDays).toBe(
      VISITOR_ANALYTICS_DEFAULTS.rawDetailRetentionDays
    );
  });

  test("respects explicit opt-in overrides", () => {
    const config = resolveVisitorAnalyticsConfig({
      VISITOR_ANALYTICS_ENABLED: "false",
      VISITOR_ANALYTICS_RAW_IP_ENABLED: "true",
      VISITOR_ANALYTICS_GEO_ENABLED: "true",
      VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS: "365",
      VISITOR_ANALYTICS_HASH_SALT: "a-non-secret-example-salt"
    } as NodeJS.ProcessEnv);

    expect(config.enabled).toBe(false);
    expect(config.rawIpEnabled).toBe(true);
    expect(config.geoEnabled).toBe(true);
    expect(config.rollupRetentionDays).toBe(365);
    expect(config.hashSalt).toBe("a-non-secret-example-salt");
  });

  test('boolean flags are true only for the literal string "true"', () => {
    expect(
      resolveVisitorAnalyticsConfig({
        VISITOR_ANALYTICS_RAW_IP_ENABLED: "TRUE"
      } as NodeJS.ProcessEnv).rawIpEnabled
    ).toBe(false);
    expect(
      resolveVisitorAnalyticsConfig({
        VISITOR_ANALYTICS_RAW_IP_ENABLED: "1"
      } as NodeJS.ProcessEnv).rawIpEnabled
    ).toBe(false);
  });
});

describe("isVisitorAnalyticsEnabled", () => {
  test("false by default (unset env) — Issue #624 repository audit addendum: default-off for new installs", () => {
    expect(isVisitorAnalyticsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("true when explicitly enabled (existing deployments that already set this var are unaffected)", () => {
    expect(
      isVisitorAnalyticsEnabled({
        VISITOR_ANALYTICS_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  test("false when explicitly disabled", () => {
    expect(
      isVisitorAnalyticsEnabled({
        VISITOR_ANALYTICS_ENABLED: "false"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("VISITOR_ANALYTICS_MODES", () => {
  test("is exactly [basic, detailed]", () => {
    expect(VISITOR_ANALYTICS_MODES).toEqual(["basic", "detailed"]);
  });
});

describe("visitorKeyCookieTtlDays (Issue #624 repository audit addendum)", () => {
  test("defaults to 30 days", () => {
    expect(
      resolveVisitorAnalyticsConfig({} as NodeJS.ProcessEnv)
        .visitorKeyCookieTtlDays
    ).toBe(30);
  });

  test("falls back to the default for a malformed value — never throws", () => {
    expect(
      resolveVisitorAnalyticsConfig({
        VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS: "not-a-number"
      } as NodeJS.ProcessEnv).visitorKeyCookieTtlDays
    ).toBe(30);
  });

  test("respects an explicit override", () => {
    expect(
      resolveVisitorAnalyticsConfig({
        VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS: "7"
      } as NodeJS.ProcessEnv).visitorKeyCookieTtlDays
    ).toBe(7);
  });
});

describe("resolveVisitorKeyCookieMaxAgeSeconds", () => {
  test("converts days to seconds", () => {
    expect(
      resolveVisitorKeyCookieMaxAgeSeconds({ visitorKeyCookieTtlDays: 30 })
    ).toBe(30 * 86_400);
    expect(
      resolveVisitorKeyCookieMaxAgeSeconds({ visitorKeyCookieTtlDays: 1 })
    ).toBe(86_400);
  });
});
