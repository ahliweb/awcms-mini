/**
 * Retention purge for the high-volume usage source tables (Issue #875, epic
 * #868, ADR-0022 §8). `usage_metering.events` is registered as a `data_lifecycle`
 * "delegated" adopter — the data_lifecycle engine only reports a dry-run
 * snapshot and NEVER mutates the table, so THIS function is the single real
 * enforcement point for "an active legal hold overrides ordinary retention"
 * (mirrors `logging`'s `purgeExpiredAuditEvents`). Bounded, age-based, per
 * tenant, and audited — the only DELETE path (the app role is REVOKE'd; the
 * content-immutability trigger forbids any in-place edit).
 *
 * Ordering: corrections are purged first, then events that have NO surviving
 * correction referencing them (respecting the FK) — a correction always keeps
 * its original event readable until it too ages out.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import type { LegalHoldGuardPort } from "../../_shared/ports/legal-hold-guard-port";
import { USAGE_METERING_EVENTS_LIFECYCLE_KEY } from "../module";

/** Usage source events feed billing — retained 2 years by default (financial evidence window), overridable per run. */
export const USAGE_EVENT_DEFAULT_RETENTION_DAYS = 730;
export const USAGE_PURGE_BATCH_LIMIT = 5000;

export type PurgeUsageEventsOptions = {
  retentionDays?: number;
  batchLimit?: number;
  now?: Date;
  correlationId?: string;
};

export type PurgeUsageEventsResult = {
  purgedEvents: number;
  purgedCorrections: number;
  cutoff: Date;
};

export async function purgeExpiredUsageEvents(
  sql: Bun.SQL,
  tenantId: string,
  legalHoldGuard: LegalHoldGuardPort,
  options: PurgeUsageEventsOptions = {}
): Promise<PurgeUsageEventsResult> {
  const retentionDays =
    options.retentionDays ?? USAGE_EVENT_DEFAULT_RETENTION_DAYS;
  const batchLimit = options.batchLimit ?? USAGE_PURGE_BATCH_LIMIT;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const held = await legalHoldGuard.isDescriptorHeld(
        tx,
        tenantId,
        USAGE_METERING_EVENTS_LIFECYCLE_KEY
      );
      if (held) {
        return { purgedEvents: 0, purgedCorrections: 0, cutoff };
      }

      const purgedCorrections = (await tx`
        DELETE FROM awcms_mini_usage_corrections
        WHERE id IN (
          SELECT id FROM awcms_mini_usage_corrections
          WHERE tenant_id = ${tenantId} AND received_at < ${cutoff}
          ORDER BY received_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[];

      const purgedEvents = (await tx`
        DELETE FROM awcms_mini_usage_events
        WHERE id IN (
          SELECT e.id FROM awcms_mini_usage_events e
          WHERE e.tenant_id = ${tenantId} AND e.received_at < ${cutoff}
            AND NOT EXISTS (
              SELECT 1 FROM awcms_mini_usage_corrections c
              WHERE c.tenant_id = ${tenantId} AND c.original_event_id = e.id
            )
          ORDER BY e.received_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[];

      if (purgedEvents.length > 0 || purgedCorrections.length > 0) {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: "usage_metering",
          action: "purge",
          resourceType: "usage_event",
          severity: "warning",
          message: `Purged ${purgedEvents.length} usage event(s) and ${purgedCorrections.length} correction(s) older than the retention cutoff.`,
          attributes: {
            retentionDays,
            cutoffIso: cutoff.toISOString(),
            purgedEvents: purgedEvents.length,
            purgedCorrections: purgedCorrections.length
          },
          correlationId: options.correlationId
        });
      }

      return {
        purgedEvents: purgedEvents.length,
        purgedCorrections: purgedCorrections.length,
        cutoff
      };
    },
    { workClass: "maintenance" }
  );
}
