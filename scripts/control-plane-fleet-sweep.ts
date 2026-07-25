/**
 * control-plane-fleet-sweep.ts — `bun run control-plane:fleet-sweep`.
 *
 * Issue #930 (epic #868 SaaS control plane, ADR-0022 §6b). The fleet-wide
 * observation sweep the control plane never had: it walks every active
 * tenant, reads each control-plane module's own operational signals inside
 * THAT tenant's RLS context, aggregates the results to fleet totals, and
 * pushes them through the metrics port.
 *
 * ## The cross-tenant read model, and why it is shaped like this
 *
 * `tenant-provisioning:reconcile` documented this gap explicitly: a
 * fleet-wide batch "would need a purpose-built cross-tenant read-model
 * (ADR-0022 §6b — a platform operator is NOT a soft super-tenant and never
 * scans all tenants' RLS tables ad hoc)". This file is that read model, and
 * the shape is the whole point:
 *
 *   1. Enumerate tenants from the GLOBAL tenant directory (`fetchActiveTenants`).
 *   2. For each tenant, open that tenant's own RLS context and read only its
 *      own rows.
 *   3. Aggregate in application memory to fleet totals.
 *
 * At no point does any query see two tenants' rows at once, and nothing needs
 * `BYPASSRLS` or a platform claim in a policy predicate — which is exactly
 * what `bun run rls:platform-claim:check` exists to keep true.
 *
 * ## Why this is the ONLY file importing five modules
 *
 * It is a composition root, the same role `scripts/` already plays for the
 * payment-outcome port wiring. Each module's collector reads only its own
 * tables; the aggregation logic itself lives in
 * `logging/application/control-plane-fleet-aggregation.ts` and takes plain
 * data, so it stays unit-testable without a database and without importing
 * anything.
 *
 * ## Read-only by construction
 *
 * Every collector issues `SELECT`s only. This job never reconciles, revokes,
 * retries, or advances anything — a sweep that both observes and mutates
 * would make "the metric moved" ambiguous between "the fleet changed" and
 * "the sweep changed it". Remediation stays in the per-tenant engines and
 * their own audited entry points.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { fetchActiveTenants } from "../src/lib/jobs/batching";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry
} from "../src/lib/jobs/job-runner";
import { withTenant } from "../src/lib/database/tenant-context";
import { listModules } from "../src/modules";
import {
  aggregateFleetTotals,
  emitFleetControlPlaneMetrics,
  type TenantControlPlaneReadings
} from "../src/modules/logging/application/control-plane-fleet-aggregation";
import { collectPaymentGatewaySignals } from "../src/modules/payment-gateway/application/control-plane-signals";
import { collectReportingSignals } from "../src/modules/reporting/application/control-plane-signals";
import { collectSubscriptionBillingSignals } from "../src/modules/subscription-billing/application/control-plane-signals";
import { collectEntitlementSignals } from "../src/modules/tenant-entitlement/application/control-plane-signals";
import { collectProvisioningSignals } from "../src/modules/tenant-provisioning/application/control-plane-signals";

async function readTenantSignals(
  sql: Bun.SQL,
  tenantId: string,
  now: Date
): Promise<TenantControlPlaneReadings> {
  const modules = listModules();

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      // Sequential, never Promise.all: every one of these runs on the SAME
      // transaction/connection, and a single Postgres connection processes
      // one query at a time — concurrency over one transaction handle has
      // produced a real hang in this repo before.
      const provisioning = await collectProvisioningSignals(tx, now);
      const entitlement = await collectEntitlementSignals(tx, now);
      const billing = await collectSubscriptionBillingSignals(tx, now);
      const payment = await collectPaymentGatewaySignals(tx);
      const reporting = await collectReportingSignals(tx, modules, now);

      return {
        provisioningBacklogByAttemptStatus: provisioning.backlogByAttemptStatus,
        provisioningOldestPendingSeconds: provisioning.oldestPendingSeconds,
        provisioningManualInterventionCount:
          provisioning.manualInterventionCount,
        entitlementExpiredUnswept: entitlement.expiredUnswept,
        billingOverdueByDunningStage: billing.overdueByDunningStage,
        billingOverdueTotal: billing.overdueTotal,
        paymentDeadLetterDepth: payment.deadLetterDepth,
        paymentWebhookBacklog: payment.webhookBacklog,
        paymentManualInterventionCount: payment.manualInterventionCount,
        projectionsStale: reporting.staleByState.stale,
        projectionsFailed: reporting.staleByState.failed
      };
    },
    { workClass: "reporting" }
  );
}

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "control-plane:fleet-sweep",
        description:
          "Walks every active tenant, reads each control-plane module's operational signals inside that tenant's own RLS context, aggregates fleet totals, and emits the control_plane_* gauges. Read-only.",
        handler: async (ctx) => {
          const now = new Date();
          const tenants = await fetchActiveTenants(sql);
          const readings: TenantControlPlaneReadings[] = [];
          let skippedAfterAbort = 0;

          for (const tenant of tenants) {
            if (ctx.signal?.aborted) {
              skippedAfterAbort += 1;
              continue;
            }
            readings.push(await readTenantSignals(sql, tenant.id, now));
          }

          const totals = aggregateFleetTotals(readings);

          // A partial sweep must NOT be published: fleet totals built from a
          // subset of tenants read as a fleet-wide DROP, which is exactly the
          // shape of a recovery. Publishing that would silently clear alerts
          // that should still be firing.
          if (!ctx.dryRun && skippedAfterAbort === 0) {
            emitFleetControlPlaneMetrics(totals);
          }

          return {
            itemCounts: {
              tenantsScanned: totals.tenantsScanned,
              tenantsSkipped: skippedAfterAbort,
              provisioningBacklog: Object.values(
                totals.provisioningBacklogByAttemptStatus
              ).reduce((sum, value) => sum + value, 0),
              entitlementExpiredUnswept: totals.entitlementExpiredUnswept,
              paymentDeadLetterDepth: totals.paymentDeadLetterDepth,
              webhookBacklog: totals.paymentWebhookBacklog,
              projectionsStale: totals.projectionsStale,
              projectionsFailed: totals.projectionsFailed
            },
            detail:
              ctx.dryRun || skippedAfterAbort > 0
                ? `Metrics NOT published (${ctx.dryRun ? "dry run" : `${skippedAfterAbort} tenant(s) skipped after cancellation`}).`
                : `Published fleet gauges from ${totals.tenantsScanned} tenant(s).`
          };
        }
      },
      { sql, dryRun: cliOptions.dryRun }
    );

    printJobTelemetry(result);
    await writeJobTelemetry(result, cliOptions.jsonOutputPath);
    console.log(formatJobOutcomeLine(result));
    applyJobExitCode(result);
    if (!isJobResultOk(result)) {
      return;
    }
  } finally {
    await sql.end?.();
  }
}

await main();
