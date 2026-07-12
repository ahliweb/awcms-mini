import { describe, expect, test } from "bun:test";

import { shouldCollectRequest } from "../../src/modules/visitor-analytics/application/collector";
import {
  VISITOR_ANALYTICS_DEFAULTS,
  type VisitorAnalyticsConfig
} from "../../src/modules/visitor-analytics/domain/visitor-analytics-config";

/**
 * Defaults to `enabled: true` (overridable) — Issue #624 repository
 * audit addendum flipped `VISITOR_ANALYTICS_DEFAULTS.enabled` itself to
 * `false`, but most tests in this file are about the per-area gating
 * flags (`collectAdmin`/`collectApi`/`collectPublic`), not the module's
 * master switch, so they need the module enabled to exercise that logic
 * at all.
 */
function configWith(
  overrides: Partial<VisitorAnalyticsConfig>
): VisitorAnalyticsConfig {
  return { ...VISITOR_ANALYTICS_DEFAULTS, enabled: true, ...overrides };
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

  test("VISITOR_ANALYTICS_DEFAULTS is disabled by default (Issue #624 repository audit addendum) — nothing is collected out of the box", () => {
    expect(
      shouldCollectRequest({
        pathname: "/admin/dashboard",
        area: "admin",
        config: VISITOR_ANALYTICS_DEFAULTS
      })
    ).toBe(false);
    expect(
      shouldCollectRequest({
        pathname: "/news",
        area: "public",
        config: VISITOR_ANALYTICS_DEFAULTS
      })
    ).toBe(false);
    expect(
      shouldCollectRequest({
        pathname: "/api/v1/health",
        area: "api",
        config: VISITOR_ANALYTICS_DEFAULTS
      })
    ).toBe(false);
  });

  test("once explicitly enabled, the default per-area flags collect admin and public but not API", () => {
    const enabledDefaults = configWith({});

    expect(
      shouldCollectRequest({
        pathname: "/admin/dashboard",
        area: "admin",
        config: enabledDefaults
      })
    ).toBe(true);
    expect(
      shouldCollectRequest({
        pathname: "/news",
        area: "public",
        config: enabledDefaults
      })
    ).toBe(true);
    expect(
      shouldCollectRequest({
        pathname: "/api/v1/health",
        area: "api",
        config: enabledDefaults
      })
    ).toBe(false);
  });
});
