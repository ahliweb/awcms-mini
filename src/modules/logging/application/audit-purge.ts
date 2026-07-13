import { withTenant } from "../../../lib/database/tenant-context";
import { recordAuditEvent } from "./audit-log";
import { LOGGING_AUDIT_EVENTS_LIFECYCLE_KEY } from "../module";
import type { LegalHoldGuardPort } from "../../_shared/ports/legal-hold-guard-port";

/**
 * Retention/purge for `awcms_mini_audit_events` (Issue #447). Doc 04
 * §Retention awal already names the policy in words — "Security/audit log:
 * 1–5 tahun sesuai kebutuhan" — but never had a concrete number or a
 * mechanism attached to it. 730 days (2 years) is the chosen default: the
 * midpoint of that documented range, long enough to cover a full annual
 * audit/tax cycle (doc 04's own "Tax records: sesuai regulasi dan SOP" and
 * "Security/audit log" sit in the same table), short enough that an
 * unbounded append-only table doesn't grow forever on a long-lived tenant.
 * Overridable per run via `AUDIT_LOG_RETENTION_DAYS` (doc 18) — a tenant
 * with a longer legal-hold requirement can be purged with a larger value,
 * or skipped entirely by not scheduling the job for it.
 */
export const AUDIT_EVENT_DEFAULT_RETENTION_DAYS = 730;

/**
 * Rows deleted per DELETE statement. Doc 04 §Aturan implementasi: purge must
 * never be a single unbounded statement that locks the table for an
 * unpredictable amount of time — mirrors the bounded-batch shape already
 * established by `object-dispatch.ts`'s claim loop (`OBJECT_DISPATCH_
 * DEFAULT_LIMIT`), just applied to a DELETE instead of an UPDATE.
 */
export const AUDIT_EVENT_PURGE_BATCH_LIMIT = 5000;

export type PurgeAuditEventsOptions = {
  /** Defaults to `AUDIT_EVENT_DEFAULT_RETENTION_DAYS`. */
  retentionDays?: number;
  /** Defaults to `AUDIT_EVENT_PURGE_BATCH_LIMIT`. */
  batchLimit?: number;
  /** Defaults to `new Date()`. Injectable for deterministic tests. */
  now?: Date;
  correlationId?: string;
};

export type PurgeAuditEventsResult = {
  purgedCount: number;
  cutoff: Date;
};

type PurgedRow = { id: string };

/**
 * Deletes ONE batch (up to `batchLimit`) of one tenant's
 * `awcms_mini_audit_events` rows older than the retention cutoff, and —
 * unless the batch was empty — records the purge itself as a new audit
 * event in the same transaction (doc 04 §Aturan implementasi: "Purge...
 * harus diaudit" — never a silent purge). `attributes` on that event never
 * lists which individual rows were deleted (there is nothing sensitive to
 * redact there — only counts/cutoff), consistent with `recordAuditEvent`'s
 * own defensive redaction.
 *
 * Callers (`scripts/audit-log-purge.ts`) loop this per tenant until it
 * returns `purgedCount: 0`, the same claim-loop shape
 * `object-dispatch.ts`'s `MAX_PASSES_PER_TENANT` already uses — so one huge
 * backlog can't hold a single DB transaction open indefinitely, and a
 * scheduled run still terminates deterministically.
 *
 * Age-only cutoff, no cascading delete: `awcms_mini_audit_events` (migration
 * 011) has no dependent FK children, so a physical DELETE here can never
 * "memutus FK penting" (doc 04).
 *
 * Legal hold enforcement (security-auditor finding, PR #773): this
 * function is `logging.audit_events`'s registered "delegated" adopter
 * (`src/modules/logging/module.ts`'s `dataLifecycle` descriptor,
 * `executionMode: "delegated"`) — the data_lifecycle module's own engine
 * NEVER mutates this table, it only reports a dry-run snapshot, so THIS
 * function is the only real enforcement point for "an active legal hold on
 * `logging.audit_events` overrides ordinary retention and cannot be
 * silently bypassed" (issue #745 critical requirement). Before deleting,
 * this asks the caller-supplied `legalHoldGuard` (a `LegalHoldGuardPort`,
 * see `_shared/ports/legal-hold-guard-port.ts`) whether this exact
 * descriptor key is held — if so, the whole batch is skipped
 * (`purgedCount: 0`) rather than deleting anything, exactly mirroring
 * `data-lifecycle/application/archive-purge-job.ts`'s own
 * `runGenericPurgePass` short-circuit for its own descriptors. Required
 * (not optional/defaulted) so no call site can silently skip the check.
 * Not imported directly from `data_lifecycle`'s `application`/`domain`
 * code — that would create a forbidden circular cross-module import (Issue
 * #685/ADR-0011); the port is the documented way around it.
 */
export async function purgeExpiredAuditEvents(
  sql: Bun.SQL,
  tenantId: string,
  legalHoldGuard: LegalHoldGuardPort,
  options: PurgeAuditEventsOptions = {}
): Promise<PurgeAuditEventsResult> {
  const retentionDays =
    options.retentionDays ?? AUDIT_EVENT_DEFAULT_RETENTION_DAYS;
  const batchLimit = options.batchLimit ?? AUDIT_EVENT_PURGE_BATCH_LIMIT;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const purgedCount = await withTenant(
    sql,
    tenantId,
    async (tx) => {
      const held = await legalHoldGuard.isDescriptorHeld(
        tx,
        tenantId,
        LOGGING_AUDIT_EVENTS_LIFECYCLE_KEY
      );
      if (held) {
        return 0;
      }

      const deleted = (await tx`
        DELETE FROM awcms_mini_audit_events
        WHERE id IN (
          SELECT id FROM awcms_mini_audit_events
          WHERE tenant_id = ${tenantId} AND created_at < ${cutoff}
          ORDER BY created_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as PurgedRow[];

      if (deleted.length > 0) {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: "logging",
          action: "purge",
          resourceType: "audit_event",
          severity: "warning",
          message: `Purged ${deleted.length} audit event(s) older than the retention cutoff.`,
          attributes: {
            retentionDays,
            cutoffIso: cutoff.toISOString(),
            purgedCount: deleted.length
          },
          correlationId: options.correlationId
        });
      }

      return deleted.length;
    },
    // "maintenance" (max 1 concurrent slot, doc 16 §Connection pooling) is
    // the correct work class for an administrative bulk-delete job — it's
    // neither a request-serving "interactive" query nor a
    // "background_sync" replication/dispatch operation.
    { workClass: "maintenance" }
  );

  return { purgedCount, cutoff };
}
