/**
 * visitor-analytics-purge.ts — `bun run analytics:purge`.
 *
 * Issue #624 (epic: visitor analytics #617-#624 — rollup job, retention
 * purge, readiness checks, docs). Internal worker entrypoint for
 * `purgeVisitorAnalyticsData`
 * (`src/modules/visitor-analytics/application/retention-purge.ts`) —
 * intended to be run on a schedule, same pattern as
 * `scripts/audit-log-purge.ts` (Issue #447): not exposed over HTTP.
 *
 * Calls `purgeVisitorAnalyticsData` DIRECTLY, exactly as that file's own
 * doc comment requires — it already implements the four retention cutoffs
 * (event delete / raw-detail clear / session delete / rollup delete) from
 * Issue #617's config, the same function `POST
 * /api/v1/analytics/retention/purge` (Issue #621) calls on demand. This
 * script never re-derives those rules a second, divergent way; it is only
 * the scheduling/iteration/audit wrapper `POST .../retention/purge`
 * doesn't need (that endpoint already audits its own on-demand call).
 *
 * No extra batching layer is added here beyond what
 * `purgeVisitorAnalyticsData` already does (one bounded set of statements
 * per tenant, already reviewed/tested in Issue #621) — adding a second,
 * divergent batching scheme on top would be exactly the kind of
 * re-derivation that file's doc comment warns against.
 *
 * Every tenant with at least one row actually purged/cleared gets its own
 * `visitor_analytics.retention_purged` audit event (`critical` severity,
 * same shape the on-demand endpoint records) — attributes are the four
 * safe row counts only, never any raw event/session data.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { withTenant } from "../src/lib/database/tenant-context";
import { recordAuditEvent } from "../src/modules/logging/application/audit-log";
import {
  purgeVisitorAnalyticsData,
  type RetentionPurgeResult
} from "../src/modules/visitor-analytics/application/retention-purge";
import {
  resolveVisitorAnalyticsConfig,
  type VisitorAnalyticsConfig
} from "../src/modules/visitor-analytics/domain/visitor-analytics-config";
import { legalHoldGuardPortAdapter } from "../src/modules/data-lifecycle/application/legal-hold-guard-port-adapter";

type TenantRow = { id: string };

export type PurgeAllTenantsOptions = {
  /** Defaults to `resolveVisitorAnalyticsConfig()` (reads `process.env`). */
  config?: VisitorAnalyticsConfig;
  /** Defaults to `new Date()`. Injectable for deterministic tests. */
  now?: Date;
  correlationId?: string;
};

export type PurgeAllTenantsResult = {
  tenantsChecked: number;
  tenantsPurged: number;
  totals: RetentionPurgeResult;
};

function hasAnyEffect(result: RetentionPurgeResult): boolean {
  return (
    result.eventsDeleted > 0 ||
    result.sessionsRawDetailCleared > 0 ||
    result.sessionsDeleted > 0 ||
    result.rollupsDeleted > 0
  );
}

/**
 * Iterates every `active` tenant and purges its visitor analytics data past
 * retention, calling `purgeVisitorAnalyticsData` DIRECTLY per tenant (see
 * file header — never re-derives its cutoffs). Only tenants where the
 * purge actually deleted/cleared something get their own `critical`
 * `retention_purged` audit event — an all-clear tenant (nothing yet past
 * retention) produces no audit noise, mirroring
 * `purgeExpiredAuditEvents`'s "empty batch writes no audit event" rule
 * (`src/modules/logging/application/audit-purge.ts`).
 *
 * Extracted from `main()` (rather than inlined) specifically so
 * `tests/integration/visitor-analytics-purge.integration.test.ts` can
 * exercise the real multi-tenant iteration + per-tenant audit behavior
 * this script adds on top of `purgeVisitorAnalyticsData` — which is
 * already covered end-to-end (all four retention cutoffs, the on-demand
 * `POST .../retention/purge` audit shape) by
 * `tests/integration/visitor-analytics-api.integration.test.ts` — without
 * re-testing those already-covered retention rules a second time.
 */
export async function purgeVisitorAnalyticsForAllTenants(
  sql: Bun.SQL,
  options: PurgeAllTenantsOptions = {}
): Promise<PurgeAllTenantsResult> {
  const config = options.config ?? resolveVisitorAnalyticsConfig();
  const now = options.now ?? new Date();
  const correlationId = options.correlationId ?? crypto.randomUUID();

  const tenants = (await sql`
    SELECT id FROM awcms_mini_tenants WHERE status = 'active'
  `) as TenantRow[];

  const totals: RetentionPurgeResult = {
    eventsDeleted: 0,
    sessionsRawDetailCleared: 0,
    sessionsDeleted: 0,
    rollupsDeleted: 0
  };
  let tenantsPurged = 0;

  for (const tenant of tenants) {
    const result = await withTenant(
      sql,
      tenant.id,
      async (tx) => {
        const purgeResult = await purgeVisitorAnalyticsData(
          tx,
          tenant.id,
          config,
          now,
          legalHoldGuardPortAdapter
        );

        if (hasAnyEffect(purgeResult)) {
          await recordAuditEvent(tx, {
            tenantId: tenant.id,
            moduleKey: "visitor_analytics",
            action: "retention_purged",
            resourceType: "visitor_analytics_data",
            resourceId: tenant.id,
            severity: "critical",
            message:
              "Scheduled visitor analytics data purged past retention window.",
            attributes: purgeResult,
            correlationId
          });
        }

        return purgeResult;
      },
      { workClass: "maintenance" }
    );

    totals.eventsDeleted += result.eventsDeleted;
    totals.sessionsRawDetailCleared += result.sessionsRawDetailCleared;
    totals.sessionsDeleted += result.sessionsDeleted;
    totals.rollupsDeleted += result.rollupsDeleted;

    if (hasAnyEffect(result)) {
      tenantsPurged += 1;
    }
  }

  return { tenantsChecked: tenants.length, tenantsPurged, totals };
}

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 045.
  const sql = getWorkerDatabaseClient();
  const correlationId = crypto.randomUUID();

  try {
    const result = await purgeVisitorAnalyticsForAllTenants(sql, {
      correlationId
    });

    console.log(
      `analytics:purge complete — correlationId=${correlationId} ` +
        `tenantsChecked=${result.tenantsChecked} tenantsPurged=${result.tenantsPurged} ` +
        `eventsDeleted=${result.totals.eventsDeleted} ` +
        `sessionsRawDetailCleared=${result.totals.sessionsRawDetailCleared} ` +
        `sessionsDeleted=${result.totals.sessionsDeleted} ` +
        `rollupsDeleted=${result.totals.rollupsDeleted}`
    );
  } catch (error) {
    logScriptFailure("analytics:purge FAILED", error);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
