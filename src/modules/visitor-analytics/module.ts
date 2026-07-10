import { defineModule } from "../_shared/module-contract";

/**
 * `visitor_analytics` (Issue #617, epic: visitor analytics #617-#624 —
 * now fully complete). Issue #617 (this descriptor) registered the
 * module, permission catalog, and env-based configuration gate; the
 * schema (#618), identity/UA/bot classification helpers (#619),
 * middleware collector (#620), analytics API (#621), admin dashboard UI
 * (#622), geolocation enrichment (#623), and rollup/retention-purge jobs
 * (#624) have since landed.
 *
 * `type: "system"` (not `"domain"`): human visitor telemetry is
 * platform/observability infrastructure every tenant shares the
 * mechanism of (same reasoning as `reporting`/`logging`), not a
 * tenant-facing business feature (contrast `blog_content`, `type:
 * "domain"`). Higher volume and different retention/privacy needs than
 * `reporting`/`logging` is exactly why it is its own module instead of
 * being folded into either (see README.md §Why a separate module).
 */
export const visitorAnalyticsModule = defineModule({
  key: "visitor_analytics",
  name: "Visitor Analytics",
  version: "0.1.0",
  status: "active",
  description:
    "Privacy-first human visitor statistics for admin and public routes, in both online and offline/LAN configurations (epic: visitor analytics #617-#624, complete). Issue #617 added the module registration, permission catalog, and env-based configuration gate — VISITOR_ANALYTICS_MODE=basic by default, with raw IP, raw user-agent, and geolocation collection all disabled unless explicitly opted in (see domain/visitor-analytics-config.ts). The tenant-scoped session/event/rollup schema (#618), identity/UA/bot classification helpers (#619), middleware telemetry collector (#620), the /api/v1/analytics API (#621), the /admin/analytics dashboard UI (#622), optional Cloudflare-based geolocation enrichment (#623), and the scheduled rollup/retention-purge jobs plus security-readiness checks (#624) have since landed.",
  dependencies: ["tenant_admin", "identity_access", "logging", "reporting"],
  type: "system",
  // Pre-declared ahead of the API landing (Issue #621), same convention
  // `tenant_domain`'s descriptor followed ahead of its own API issue
  // (#562) — the OpenAPI path is the repo-wide single spec file, not a
  // per-module file.
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/analytics"
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_visitor_analytics",
      path: "/admin/analytics",
      order: 70,
      requiredPermission: "visitor_analytics.dashboard.read"
    }
  ],
  permissions: [
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
  ]
});
