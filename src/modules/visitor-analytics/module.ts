import { defineModule } from "../_shared/module-contract";

/**
 * Single source of truth for this module's `dataLifecycle` descriptor key,
 * shared with `application/retention-purge.ts` so the actual purge function
 * and the registry entry a legal hold is created against can never drift
 * apart (security-auditor finding, PR #773).
 */
export const VISITOR_ANALYTICS_VISIT_EVENTS_LIFECYCLE_KEY =
  "visitor_analytics.visit_events";

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
  ],
  // Issue #745 (data_lifecycle, epic #738) — registered as a representative
  // "delegated" adopter: data_lifecycle's dry-run planner may READ this
  // table for backlog visibility, but real purge stays owned by
  // `purgeVisitorAnalyticsData` (`bun run analytics:purge`, and
  // `POST /api/v1/analytics/retention/purge`), unchanged.
  dataLifecycle: [
    {
      key: VISITOR_ANALYTICS_VISIT_EVENTS_LIFECYCLE_KEY,
      tableName: "awcms_mini_visit_events",
      ownerModuleKey: "visitor_analytics",
      scope: "tenant",
      cursorColumn: "occurred_at",
      retentionClass: "analytics_telemetry",
      retentionMinDays: 7,
      retentionMaxDays: 730,
      defaultRetentionDays: 90,
      partition: {
        eligible: true,
        granularity: "daily",
        rationale:
          "One row per page-view/API call — by far the highest insert rate of any table this module registers. A strong daily range-partition candidate given the short (90d default) retention window, not automated by this issue (destructive migration of an existing table is out of scope) — tracked as partitioning runbook guidance."
      },
      archive: {
        archivable: false,
        rationale:
          "Current reality: purgeVisitorAnalyticsData performs straight DELETE/UPDATE-to-null operations with no archive step (privacy-first design — raw/near-raw visitor detail is deliberately NOT retained longer than necessary, so archiving it would work against the module's own privacy posture)."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Matches purgeVisitorAnalyticsData's eventsDeleted step exactly (a straight DELETE) — visitor_sessions' separate raw-detail anonymization step is a different table/descriptor, not registered by this issue."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "occurred_at"],
          purpose:
            "awcms_mini_visit_events_tenant_occurred_idx (migration 039) — the same index purgeVisitorAnalyticsData's own age-based DELETE already relies on."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore (docs/awcms-mini/resilience-dr-verification.md); no standalone archive artifact exists yet (archive.archivable is false above) — by design, given the privacy-first retention posture.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run analytics:purge",
        purgeFunctionRef:
          "src/modules/visitor-analytics/application/retention-purge.ts#purgeVisitorAnalyticsData",
        description:
          "Deletes/clears four categories of visitor analytics data past their respective retention cutoffs (events, session raw detail, sessions, rollups) — the same function both the scheduled job and the on-demand POST /api/v1/analytics/retention/purge endpoint call. Unchanged by Issue #745."
      }
    }
  ]
});
