/**
 * Retention purge for the payment-gateway webhook evidence tables (Issue
 * #932, epic #868, ADR-0022 §8).
 *
 * ## Why this file exists
 *
 * Until migration 102, these four tables could not have a row deleted by ANY
 * role — their `BEFORE UPDATE OR DELETE` triggers raised unconditionally, so
 * "append-only" meant "retained forever", including for the migration owner.
 * Migration 102 narrowed those triggers to `BEFORE UPDATE` (every in-place-edit
 * protection unchanged) and moved the delete boundary to grants:
 * `awcms_mini_app` still cannot delete anything, and `awcms_mini_worker` can —
 * which makes THIS FUNCTION the single, real delete path for the module, and
 * therefore the single real enforcement point for "an active legal hold
 * overrides ordinary retention". Same shape as `usage_metering`'s
 * `purgeExpiredUsageEvents` and `logging`'s `purgeExpiredAuditEvents`.
 *
 * ## FK-safe ordering (the part that is easy to get wrong)
 *
 * The evidence chain is
 * `webhook_inbox <- normalized_events <- processing_attempts`, with NOT NULL
 * foreign keys pointing UP the chain, plus `reconciliations`, which is
 * independent (it references payment intents only).
 *
 * Age alone is NOT a safe cutoff: an inbox row is always OLDER than the
 * normalized event derived from it, so a pure age-ordered delete would try to
 * remove the parent while a not-yet-aged child still references it and fail on
 * the foreign key. Each level therefore deletes only rows with NO SURVIVING
 * CHILD — exactly the `NOT EXISTS` guard `purgeExpiredUsageEvents` uses for
 * events-with-corrections. The practical effect is that evidence ages out as a
 * whole chain rather than in fragments: a webhook whose processing attempts are
 * still inside the retention window keeps its inbox row readable.
 *
 * Children are purged first within a single run so one pass can retire a whole
 * chain, but correctness does not depend on that ordering — a run interrupted
 * between statements simply leaves the parent for the next run.
 *
 * ## Bounded, audited, retryable
 *
 * One bounded batch per table per call (`batchLimit`), inside ONE transaction
 * (pure DB work, no external I/O, ADR-0006-compliant). Re-running is always
 * safe: the cutoff is recomputed and already-deleted rows simply do not match.
 * A non-empty run writes one audit row.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import type { LegalHoldGuardPort } from "../../_shared/ports/legal-hold-guard-port";
import {
  PAYMENT_GATEWAY_RECONCILIATIONS_LIFECYCLE_KEY,
  WEBHOOK_EVIDENCE_CHAIN_LIFECYCLE_KEYS
} from "../domain/lifecycle-keys";

/**
 * Provider webhook evidence supports dispute/chargeback investigation, which
 * providers themselves typically bound to a year or less — 400 days keeps a
 * full year plus a margin, and is overridable per run. Deliberately SHORTER
 * than the billing evidence window `usage_metering` uses (730 days): this is
 * transport-level delivery evidence, not the billing record itself, and the
 * commercial outcome it produced lives in `payment_intents`/`refunds`, which
 * this purge never touches.
 */
export const PAYMENT_EVIDENCE_DEFAULT_RETENTION_DAYS = 400;
export const PAYMENT_PURGE_BATCH_LIMIT = 5000;

export type PurgePaymentEvidenceOptions = {
  retentionDays?: number;
  batchLimit?: number;
  now?: Date;
  correlationId?: string;
};

export type PurgePaymentEvidenceResult = {
  purgedProcessingAttempts: number;
  purgedNormalizedEvents: number;
  purgedWebhookInbox: number;
  purgedReconciliations: number;
  /** True when an active legal hold blocked the webhook evidence chain — distinct from "nothing had aged out yet", which reports zeros with this false. */
  legalHoldBlocked: boolean;
  /** True when an active legal hold blocked the reconciliation log. Reported separately because the two descriptors are held independently: a hold on one must never be read as covering, or as excusing, the other. */
  reconciliationLegalHoldBlocked: boolean;
  cutoff: Date;
};

export async function purgeExpiredPaymentEvidence(
  sql: Bun.SQL,
  tenantId: string,
  legalHoldGuard: LegalHoldGuardPort,
  options: PurgePaymentEvidenceOptions = {}
): Promise<PurgePaymentEvidenceResult> {
  const retentionDays =
    options.retentionDays ?? PAYMENT_EVIDENCE_DEFAULT_RETENTION_DAYS;
  const batchLimit = options.batchLimit ?? PAYMENT_PURGE_BATCH_LIMIT;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      // EVERY descriptor this purge can delete from is checked, and each
      // check gates only what it covers. Two rules:
      //
      // 1. A hold on ANY link of the evidence chain blocks all three tables.
      //    Purging part of a held chain would leave evidence that cannot be
      //    interpreted (an inbox row with no outcome) or an outcome with no
      //    provenance — so the chain is held as a unit, fail-closed.
      // 2. `reconciliations` is genuinely independent and is held separately:
      //    a hold on the chain must never be read as covering it, nor as
      //    excusing it.
      //
      // Sequential, not `Promise.all` — every query runs on the SAME
      // transaction/connection (a single Postgres connection processes one
      // query at a time; concurrency here produced a real hang in this repo).
      let evidenceHeld = false;
      for (const chainKey of WEBHOOK_EVIDENCE_CHAIN_LIFECYCLE_KEYS) {
        if (await legalHoldGuard.isDescriptorHeld(tx, tenantId, chainKey)) {
          evidenceHeld = true;
          break;
        }
      }
      const reconciliationsHeld = await legalHoldGuard.isDescriptorHeld(
        tx,
        tenantId,
        PAYMENT_GATEWAY_RECONCILIATIONS_LIFECYCLE_KEY
      );

      // Leaf first: nothing references a processing attempt.
      const purgedProcessingAttempts = evidenceHeld
        ? []
        : ((await tx`
        DELETE FROM awcms_mini_payment_gateway_processing_attempts
        WHERE id IN (
          SELECT id FROM awcms_mini_payment_gateway_processing_attempts
          WHERE tenant_id = ${tenantId} AND created_at < ${cutoff}
          ORDER BY created_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[]);

      // Then normalized events with no surviving attempt referencing them.
      const purgedNormalizedEvents = evidenceHeld
        ? []
        : ((await tx`
        DELETE FROM awcms_mini_payment_gateway_normalized_events
        WHERE id IN (
          SELECT n.id FROM awcms_mini_payment_gateway_normalized_events n
          WHERE n.tenant_id = ${tenantId} AND n.created_at < ${cutoff}
            AND NOT EXISTS (
              SELECT 1 FROM awcms_mini_payment_gateway_processing_attempts a
              WHERE a.tenant_id = ${tenantId} AND a.normalized_event_id = n.id
            )
          ORDER BY n.created_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[]);

      // Then inbox rows with no surviving normalized event referencing them.
      const purgedWebhookInbox = evidenceHeld
        ? []
        : ((await tx`
        DELETE FROM awcms_mini_payment_gateway_webhook_inbox
        WHERE id IN (
          SELECT w.id FROM awcms_mini_payment_gateway_webhook_inbox w
          WHERE w.tenant_id = ${tenantId} AND w.received_at < ${cutoff}
            AND NOT EXISTS (
              SELECT 1 FROM awcms_mini_payment_gateway_normalized_events n
              WHERE n.tenant_id = ${tenantId} AND n.webhook_inbox_id = w.id
            )
          ORDER BY w.received_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[]);

      // Independent of the chain above (references payment intents only, and
      // an intent is never purged here), so it is held and purged separately.
      const purgedReconciliations = reconciliationsHeld
        ? []
        : ((await tx`
        DELETE FROM awcms_mini_payment_gateway_reconciliations
        WHERE id IN (
          SELECT id FROM awcms_mini_payment_gateway_reconciliations
          WHERE tenant_id = ${tenantId} AND created_at < ${cutoff}
          ORDER BY created_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[]);

      const total =
        purgedProcessingAttempts.length +
        purgedNormalizedEvents.length +
        purgedWebhookInbox.length +
        purgedReconciliations.length;

      if (total > 0) {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: "payment_gateway",
          action: "purge",
          resourceType: "payment_webhook_evidence",
          severity: "warning",
          message: `Purged ${total} payment webhook evidence row(s) older than the retention cutoff.`,
          attributes: {
            retentionDays,
            cutoffIso: cutoff.toISOString(),
            purgedProcessingAttempts: purgedProcessingAttempts.length,
            purgedNormalizedEvents: purgedNormalizedEvents.length,
            purgedWebhookInbox: purgedWebhookInbox.length,
            purgedReconciliations: purgedReconciliations.length,
            evidenceLegalHoldBlocked: evidenceHeld,
            reconciliationLegalHoldBlocked: reconciliationsHeld
          },
          correlationId: options.correlationId
        });
      }

      return {
        purgedProcessingAttempts: purgedProcessingAttempts.length,
        purgedNormalizedEvents: purgedNormalizedEvents.length,
        purgedWebhookInbox: purgedWebhookInbox.length,
        purgedReconciliations: purgedReconciliations.length,
        legalHoldBlocked: evidenceHeld,
        reconciliationLegalHoldBlocked: reconciliationsHeld,
        cutoff
      };
    },
    { workClass: "maintenance" }
  );
}
