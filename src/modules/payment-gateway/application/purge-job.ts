/**
 * Payment webhook evidence retention job orchestration (Issue #932, epic #868,
 * ADR-0022 §8). Extracted from `scripts/payment-gateway-purge.ts` so
 * integration tests can drive real per-tenant iteration without a subprocess —
 * the same split `runUsageMeteringPurge`/`runAuditLogPurge` already use.
 *
 * The single real enforcement point for the delegated
 * `payment_gateway.webhook_evidence` and `payment_gateway.reconciliations`
 * data_lifecycle policies, and the ONLY delete path for those tables (see
 * `retention-purge.ts`'s header for why one exists at all now).
 */
import {
  iterateTenantsInBatches,
  fetchActiveTenants
} from "../../../lib/jobs/batching";
import type { JobContext } from "../../../lib/jobs/job-runner";
import type { LegalHoldGuardPort } from "../../_shared/ports/legal-hold-guard-port";
import {
  PAYMENT_EVIDENCE_DEFAULT_RETENTION_DAYS,
  purgeExpiredPaymentEvidence
} from "./retention-purge";

export type PaymentGatewayPurgeOptions = {
  retentionDays?: number;
  now?: Date;
  batchLimit?: number;
  maxPasses?: number;
};

export type PaymentGatewayPurgeResult = {
  tenantsChecked: number;
  totalPurged: number;
  purgedProcessingAttempts: number;
  purgedNormalizedEvents: number;
  purgedWebhookInbox: number;
  purgedReconciliations: number;
  /** Tenants where an active legal hold blocked at least one descriptor — surfaced rather than folded into "nothing to purge", so a hold is visible in job telemetry instead of looking like a quiet no-op. */
  tenantsUnderLegalHold: string[];
  cutoffIso: string;
  tenantsHitPassLimit: string[];
};

function resolveRetentionDays(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return override;
  }
  const envValue = process.env.PAYMENT_EVIDENCE_RETENTION_DAYS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return PAYMENT_EVIDENCE_DEFAULT_RETENTION_DAYS;
}

export async function runPaymentGatewayPurge(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  legalHoldGuard: LegalHoldGuardPort,
  options: PaymentGatewayPurgeOptions = {}
): Promise<PaymentGatewayPurgeResult> {
  const retentionDays = resolveRetentionDays(options.retentionDays);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);
    return {
      tenantsChecked: tenants.length,
      totalPurged: 0,
      purgedProcessingAttempts: 0,
      purgedNormalizedEvents: 0,
      purgedWebhookInbox: 0,
      purgedReconciliations: 0,
      tenantsUnderLegalHold: [],
      cutoffIso: cutoff.toISOString(),
      tenantsHitPassLimit: []
    };
  }

  let purgedProcessingAttempts = 0;
  let purgedNormalizedEvents = 0;
  let purgedWebhookInbox = 0;
  let purgedReconciliations = 0;
  const tenantsUnderLegalHold: string[] = [];

  const { tenants, totalCount, perTenant } = await iterateTenantsInBatches(
    sql,
    async (tenantId) => {
      const result = await purgeExpiredPaymentEvidence(
        sql,
        tenantId,
        legalHoldGuard,
        {
          retentionDays,
          now,
          batchLimit: options.batchLimit,
          correlationId: ctx.correlationId
        }
      );

      purgedProcessingAttempts += result.purgedProcessingAttempts;
      purgedNormalizedEvents += result.purgedNormalizedEvents;
      purgedWebhookInbox += result.purgedWebhookInbox;
      purgedReconciliations += result.purgedReconciliations;

      if (result.legalHoldBlocked || result.reconciliationLegalHoldBlocked) {
        tenantsUnderLegalHold.push(tenantId);
      }

      return {
        count:
          result.purgedProcessingAttempts +
          result.purgedNormalizedEvents +
          result.purgedWebhookInbox +
          result.purgedReconciliations
      };
    },
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  const tenantsHitPassLimit = [...perTenant.entries()]
    .filter(([, outcome]) => outcome.hitPassLimit)
    .map(([tenantId]) => tenantId);

  return {
    tenantsChecked: tenants.length,
    totalPurged: totalCount,
    purgedProcessingAttempts,
    purgedNormalizedEvents,
    purgedWebhookInbox,
    purgedReconciliations,
    tenantsUnderLegalHold,
    cutoffIso: cutoff.toISOString(),
    tenantsHitPassLimit
  };
}
