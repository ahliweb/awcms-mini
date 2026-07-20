/**
 * Usage retention purge job orchestration (Issue #875, epic #868, ADR-0022 §8).
 * Extracted from `scripts/usage-metering-purge.ts` so integration tests can
 * drive real per-tenant iteration without a subprocess (same pattern as
 * `runAuditLogPurge`). The single real enforcement point for the delegated
 * `usage_metering.events` data_lifecycle policy: bounded, age-based, per tenant,
 * legal-hold-respecting, audited. The ONLY DELETE path for usage source rows.
 */
import {
  fetchActiveTenants,
  iterateTenantsInBatches
} from "../../../lib/jobs/batching";
import type { JobContext } from "../../../lib/jobs/job-runner";
import type { LegalHoldGuardPort } from "../../_shared/ports/legal-hold-guard-port";
import {
  purgeExpiredUsageEvents,
  USAGE_EVENT_DEFAULT_RETENTION_DAYS
} from "./retention-purge";

export type UsageMeteringPurgeOptions = {
  retentionDays?: number;
  now?: Date;
  batchLimit?: number;
  maxPasses?: number;
};

export type UsageMeteringPurgeResult = {
  tenantsChecked: number;
  totalPurged: number;
  purgedEvents: number;
  purgedCorrections: number;
  cutoffIso: string;
  tenantsHitPassLimit: string[];
};

function resolveRetentionDays(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return override;
  }
  const envValue = process.env.USAGE_EVENT_RETENTION_DAYS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return USAGE_EVENT_DEFAULT_RETENTION_DAYS;
}

export async function runUsageMeteringPurge(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  legalHoldGuard: LegalHoldGuardPort,
  options: UsageMeteringPurgeOptions = {}
): Promise<UsageMeteringPurgeResult> {
  const retentionDays = resolveRetentionDays(options.retentionDays);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);
    return {
      tenantsChecked: tenants.length,
      totalPurged: 0,
      purgedEvents: 0,
      purgedCorrections: 0,
      cutoffIso: cutoff.toISOString(),
      tenantsHitPassLimit: []
    };
  }

  let purgedEvents = 0;
  let purgedCorrections = 0;

  const { tenants, totalCount, perTenant } = await iterateTenantsInBatches(
    sql,
    async (tenantId) => {
      const result = await purgeExpiredUsageEvents(
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
      purgedEvents += result.purgedEvents;
      purgedCorrections += result.purgedCorrections;
      return { count: result.purgedEvents + result.purgedCorrections };
    },
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  const tenantsHitPassLimit = [...perTenant.entries()]
    .filter(([, outcome]) => outcome.hitPassLimit)
    .map(([tenantId]) => tenantId);

  return {
    tenantsChecked: tenants.length,
    totalPurged: totalCount,
    purgedEvents,
    purgedCorrections,
    cutoffIso: cutoff.toISOString(),
    tenantsHitPassLimit
  };
}
