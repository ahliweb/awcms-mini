import { describe, expect, test } from "bun:test";

import { shouldCollectRequest } from "../../src/modules/visitor-analytics/application/collector";
import {
  VISITOR_ANALYTICS_DEFAULTS,
  type VisitorAnalyticsConfig
} from "../../src/modules/visitor-analytics/domain/visitor-analytics-config";

function configWith(
  overrides: Partial<VisitorAnalyticsConfig>
): VisitorAnalyticsConfig {
  return { ...VISITOR_ANALYTICS_DEFAULTS, ...overrides };
}

describe("shouldCollectRequest", () => {
  test("false when the module is disabled entirely", () => {
    expect(
      shouldCollectRequest({
        pathname: "/news",
        area: "public",
        config: configWith({ enabled: false })
      })
    ).toBe(false);
  });

  test("false for a non-trackable path (static asset), regardless of every other flag", () => {
    expect(
      shouldCollectRequest({
        pathname: "/_astro/client.js",
        area: "public",
        config: configWith({
          enabled: true,
          collectAdmin: true,
          collectPublic: true,
          collectApi: true
        })
      })
    ).toBe(false);
  });

  test("admin area gated by collectAdmin only", () => {
    expect(
      shouldCollectRequest({
        pathname: "/admin/dashboard",
        area: "admin",
        config: configWith({ collectAdmin: true })
      })
    ).toBe(true);
    expect(
      shouldCollectRequest({
        pathname: "/admin/dashboard",
        area: "admin",
        config: configWith({ collectAdmin: false })
      })
    ).toBe(false);
  });

  test("api-shaped paths gated by collectApi regardless of area label", () => {
    expect(
      shouldCollectRequest({
        pathname: "/api/v1/blog/posts",
        area: "api",
        config: configWith({ collectApi: true })
      })
    ).toBe(true);
    expect(
      shouldCollectRequest({
        pathname: "/api/v1/blog/posts",
        area: "api",
        config: configWith({ collectApi: false })
      })
    ).toBe(false);
  });

  test("public pages gated by collectPublic", () => {
    expect(
      shouldCollectRequest({
        pathname: "/news/hello-world",
        area: "public",
        config: configWith({ collectPublic: true })
      })
    ).toBe(true);
    expect(
      shouldCollectRequest({
        pathname: "/news/hello-world",
        area: "public",
        config: configWith({ collectPublic: false })
      })
    ).toBe(false);
  });

  test("default config collects admin and public but not API", () => {
    expect(
      shouldCollectRequest({
        pathname: "/admin/dashboard",
        area: "admin",
        config: VISITOR_ANALYTICS_DEFAULTS
      })
    ).toBe(true);
    expect(
      shouldCollectRequest({
        pathname: "/news",
        area: "public",
        config: VISITOR_ANALYTICS_DEFAULTS
      })
    ).toBe(true);
    expect(
      shouldCollectRequest({
        pathname: "/api/v1/health",
        area: "api",
        config: VISITOR_ANALYTICS_DEFAULTS
      })
    ).toBe(false);
  });
});
