/**
 * On-demand visitor analytics retention purge (Issue #621, epic: visitor
 * analytics #617-#624), triggered via `POST /api/v1/analytics/retention/purge`.
 * The scheduled job wrapper (`bun run analytics:retention:purge`, mirroring
 * `logs:audit:purge`) is Issue #624's job — it will call this exact
 * function rather than re-deriving the purge rules a second time.
 *
 * Three independent cutoffs, each from Issue #617's config
 * (`VisitorAnalyticsConfig`):
 *   1. `awcms_mini_visit_events` older than `eventRetentionDays` — hard
 *      deleted.
 *   2. `awcms_mini_visitor_sessions.ip_address`/`login_identifier_snapshot`
 *      (the two genuinely "raw detail" columns) older than
 *      `rawDetailRetentionDays` — cleared in place, row kept (device/
 *      browser aggregate fields remain useful long after raw detail
 *      should be gone).
 *   3. `awcms_mini_visitor_sessions` rows older than `eventRetentionDays`
 *      — hard deleted. Safe to run *after* step 1: a session's
 *      `last_seen_at` is always >= every one of its own events'
 *      `occurred_at` (the collector bumps `last_seen_at` at the same time
 *      it inserts the triggering event, `application/collector.ts`), so
 *      once a session is older than the event cutoff, every event that
 *      referenced it (via `visit_events.visitor_session_id`) has already
 *      been deleted in step 1 — the FK (no `ON DELETE` clause, i.e.
 *      `RESTRICT`) is satisfied.
 *   4. `awcms_mini_visitor_daily_rollups` older than
 *      `rollupRetentionDays` — hard deleted (defensive; this table is
 *      always empty until Issue #624's rollup job exists, but the purge
 *      rule is written now so #624 doesn't need to touch this function).
 */
import type { VisitorAnalyticsConfig } from "../domain/visitor-analytics-config";

export type RetentionPurgeResult = {
  eventsDeleted: number;
  sessionsRawDetailCleared: number;
  sessionsDeleted: number;
  rollupsDeleted: number;
};

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function purgeVisitorAnalyticsData(
  tx: Bun.SQL,
  tenantId: string,
  config: VisitorAnalyticsConfig,
  now: Date
): Promise<RetentionPurgeResult> {
  const eventCutoff = daysAgo(now, config.eventRetentionDays);
  const rawDetailCutoff = daysAgo(now, config.rawDetailRetentionDays);
  const rollupCutoff = daysAgo(now, config.rollupRetentionDays)
    .toISOString()
    .slice(0, 10);

  const deletedEvents = await tx`
    DELETE FROM awcms_mini_visit_events
    WHERE tenant_id = ${tenantId} AND occurred_at < ${eventCutoff}
    RETURNING id
  `;

  const clearedSessions = await tx`
    UPDATE awcms_mini_visitor_sessions
    SET ip_address = NULL, login_identifier_snapshot = NULL, updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND last_seen_at < ${rawDetailCutoff}
      AND (ip_address IS NOT NULL OR login_identifier_snapshot IS NOT NULL)
    RETURNING id
  `;

  const deletedSessions = await tx`
    DELETE FROM awcms_mini_visitor_sessions
    WHERE tenant_id = ${tenantId} AND last_seen_at < ${eventCutoff}
    RETURNING id
  `;

  const deletedRollups = await tx`
    DELETE FROM awcms_mini_visitor_daily_rollups
    WHERE tenant_id = ${tenantId} AND date < ${rollupCutoff}
    RETURNING tenant_id
  `;

  return {
    eventsDeleted: deletedEvents.length,
    sessionsRawDetailCleared: clearedSessions.length,
    sessionsDeleted: deletedSessions.length,
    rollupsDeleted: deletedRollups.length
  };
}
