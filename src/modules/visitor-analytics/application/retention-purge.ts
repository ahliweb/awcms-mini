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
 *      — hard deleted, but only ones with no remaining `visit_events` row
 *      (`NOT EXISTS`, post-review fix). A session's `last_seen_at` is
 *      *usually* >= its newest event's `occurred_at`, but not always: the
 *      collector's own write-throttle
 *      (`application/collector.ts`'s `SESSION_UPDATE_THROTTLE_MS`, 30s)
 *      deliberately skips the `last_seen_at` UPDATE on rapid repeat
 *      requests from the same visitor while still inserting a fresh
 *      event every time — so `last_seen_at` can trail the session's
 *      newest event by up to ~30s. Relying on "session older than cutoff
 *      implies its events are already gone" (the original version of
 *      this comment) is therefore not a true invariant: a purge call
 *      landing inside that ~30s straddle window could hit
 *      `awcms_mini_visit_events.visitor_session_id`'s FK (no `ON DELETE`
 *      clause, i.e. `RESTRICT`) and abort the whole transaction. The
 *      `NOT EXISTS` guard below makes the delete self-defending instead
 *      of depending on that timing assumption — a session with any
 *      remaining event (regardless of why) is simply left for a later
 *      purge run, never a hard failure.
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
    DELETE FROM awcms_mini_visitor_sessions s
    WHERE s.tenant_id = ${tenantId} AND s.last_seen_at < ${eventCutoff}
      AND NOT EXISTS (
        SELECT 1 FROM awcms_mini_visit_events e
        WHERE e.visitor_session_id = s.id
      )
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
