/**
 * On-demand visitor analytics retention purge (Issue #621, epic: visitor
 * analytics #617-#624), triggered via `POST /api/v1/analytics/retention/purge`.
 * The scheduled job wrapper (`bun run analytics:purge`,
 * `scripts/visitor-analytics-purge.ts`, mirroring `logs:audit:purge`) is
 * Issue #624's job — it calls this exact function (via
 * `purgeVisitorAnalyticsForAllTenants`) rather than re-deriving the purge
 * rules a second time.
 *
 * Four independent cutoffs, each from Issue #617's config
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
 *      `rollupRetentionDays` — hard deleted. Written when this function
 *      was still Issue #621-only (this table was always empty back
 *      then, since the rollup job didn't exist yet) — now that Issue
 *      #624's `bun run analytics:rollup` populates it, this rule
 *      applies to real rows without needing any change here.
 *
 * Legal hold enforcement (security-auditor finding, PR #773): step 1 above
 * (`awcms_mini_visit_events`) is this module's registered "delegated"
 * adopter for `visitor_analytics.visit_events`
 * (`src/modules/visitor-analytics/module.ts`'s `dataLifecycle` descriptor)
 * — the data_lifecycle module's own engine never mutates this table, only
 * reports a dry-run snapshot, so THIS function is the real enforcement
 * point. Before step 1's DELETE, this asks the caller-supplied
 * `legalHoldGuard` (a `LegalHoldGuardPort`, see
 * `_shared/ports/legal-hold-guard-port.ts`) and skips ONLY that step if
 * `visitor_analytics.visit_events` is held — steps 2-4 (session raw-detail
 * clearing, session deletion, rollup deletion) are not covered by any
 * registered descriptor today and are unaffected, matching the exact scope
 * this issue's registry advertises protection for. Not imported directly
 * from `data_lifecycle`'s `application`/`domain` code — that would create a
 * forbidden circular cross-module import (Issue #685/ADR-0011); the port
 * is the documented way around it.
 */
import type { VisitorAnalyticsConfig } from "../domain/visitor-analytics-config";
import { VISITOR_ANALYTICS_VISIT_EVENTS_LIFECYCLE_KEY } from "../module";
import type { LegalHoldGuardPort } from "../../_shared/ports/legal-hold-guard-port";

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
  now: Date,
  legalHoldGuard: LegalHoldGuardPort
): Promise<RetentionPurgeResult> {
  const eventCutoff = daysAgo(now, config.eventRetentionDays);
  const rawDetailCutoff = daysAgo(now, config.rawDetailRetentionDays);
  const rollupCutoff = daysAgo(now, config.rollupRetentionDays)
    .toISOString()
    .slice(0, 10);

  const visitEventsHeld = await legalHoldGuard.isDescriptorHeld(
    tx,
    tenantId,
    VISITOR_ANALYTICS_VISIT_EVENTS_LIFECYCLE_KEY
  );

  const deletedEvents = visitEventsHeld
    ? []
    : await tx`
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
