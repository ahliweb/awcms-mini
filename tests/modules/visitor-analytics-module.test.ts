import { describe, expect, test } from "bun:test";

import { getModuleByKey, listModules } from "../../src/modules";
import { visitorAnalyticsModule } from "../../src/modules/visitor-analytics/module";

// Issue #617 — the eight permissions seeded by
// sql/038_awcms_mini_visitor_analytics_permissions.sql, verbatim. The
// descriptor's `permissions` array must match this list exactly
// (activityCode/action/description) or Module Management's permission
// sync/status report will show `missing`/`mismatched_description` for
// this module.
const MIGRATION_038_PERMISSIONS = [
  {
    activityCode: "dashboard",
    action: "read",
    description: "Read the visitor analytics dashboard"
  },
  {
    activityCode: "realtime",
    action: "read",
    description: "Read real-time/online visitor counts"
  },
  {
    activityCode: "sessions",
    action: "read",
    description: "Read visitor session records"
  },
  {
    activityCode: "events",
    action: "read",
    description: "Read visitor page-view/event records"
  },
  {
    activityCode: "raw_detail",
    action: "read",
    description:
      "Read raw visitor detail (IP address, user-agent) separate from aggregate dashboard access"
  },
  {
    activityCode: "settings",
    action: "read",
    description: "Read visitor analytics module settings"
  },
  {
    activityCode: "settings",
    action: "update",
    description: "Update visitor analytics module settings"
  },
  {
    activityCode: "retention",
    action: "purge",
    description: "Purge visitor analytics data past its retention window"
  }
];

describe("visitor_analytics module descriptor (Issue #617)", () => {
  test("listModules() includes visitor_analytics", () => {
    expect(listModules().some((m) => m.key === "visitor_analytics")).toBe(true);
    expect(getModuleByKey("visitor_analytics")).toBe(visitorAnalyticsModule);
  });

  test("descriptor shape matches the issue's requirements", () => {
    expect(visitorAnalyticsModule.key).toBe("visitor_analytics");
    expect(visitorAnalyticsModule.status).toBe("active");
    expect(visitorAnalyticsModule.type).toBe("system");
    expect(visitorAnalyticsModule.dependencies).toEqual([
      "tenant_admin",
      "identity_access",
      "logging",
      "reporting"
    ]);
  });

  test("api.basePath matches the issue's later API scope (#621)", () => {
    expect(visitorAnalyticsModule.api?.basePath).toBe("/api/v1/analytics");
    expect(visitorAnalyticsModule.api?.openApiPath).toBe(
      "openapi/awcms-mini-public-api.openapi.yaml"
    );
  });

  test("navigation.path matches the issue's requirement and is permission-gated", () => {
    expect(visitorAnalyticsModule.navigation).toHaveLength(1);
    expect(visitorAnalyticsModule.navigation?.[0]?.path).toBe(
      "/admin/analytics"
    );
    expect(visitorAnalyticsModule.navigation?.[0]?.requiredPermission).toBe(
      "visitor_analytics.dashboard.read"
    );
  });

  test("permissions array matches migration 038's seed exactly", () => {
    expect(visitorAnalyticsModule.permissions).toEqual(
      MIGRATION_038_PERMISSIONS
    );
  });

  test("permissions use the same module_key/activity_code the migration seeded", () => {
    const permissionKeys = (visitorAnalyticsModule.permissions ?? []).map(
      (p) => `${visitorAnalyticsModule.key}.${p.activityCode}.${p.action}`
    );

    expect(permissionKeys).toEqual([
      "visitor_analytics.dashboard.read",
      "visitor_analytics.realtime.read",
      "visitor_analytics.sessions.read",
      "visitor_analytics.events.read",
      "visitor_analytics.raw_detail.read",
      "visitor_analytics.settings.read",
      "visitor_analytics.settings.update",
      "visitor_analytics.retention.purge"
    ]);
  });

  test("raw_detail.read is a distinct permission from dashboard.read (privacy separation)", () => {
    const activityCodes = (visitorAnalyticsModule.permissions ?? []).map(
      (p) => p.activityCode
    );

    expect(activityCodes).toContain("raw_detail");
    expect(activityCodes).toContain("dashboard");
  });

  test("descriptor never declares a secret, token, or provider credential", () => {
    const serialized = JSON.stringify(visitorAnalyticsModule).toLowerCase();

    for (const forbidden of [
      "password",
      "token",
      "secret",
      "credential",
      "apikey",
      "api_key"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("the module never declares jobs, health, or settings before those capabilities are real", () => {
    // Consistent with tenant_domain's own precedent (Issue #558): a
    // descriptor should only claim jobs/health/settings once the
    // corresponding feature exists. None of them exist for
    // visitor_analytics as of Issue #617 (rollup/retention jobs land in
    // #624; no module-settings surface has been built yet either).
    expect(visitorAnalyticsModule.jobs).toBeUndefined();
    expect(visitorAnalyticsModule.health).toBeUndefined();
    expect(visitorAnalyticsModule.settings).toBeUndefined();
  });
});
