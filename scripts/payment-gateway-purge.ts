/**
 * payment-gateway-purge.ts — `bun run payment-gateway:purge`.
 *
 * Issue #932 (epic #868 SaaS control plane, ADR-0022 §8). Scheduled worker
 * entrypoint for `runPaymentGatewayPurge`
 * (`src/modules/payment-gateway/application/purge-job.ts`) — same shape as
 * `scripts/usage-metering-purge.ts`: shared worker runner (advisory lock,
 * timeout, SIGTERM/SIGINT cancellation, JSON telemetry), never exposed over
 * HTTP.
 *
 * This is the ONLY delete path for the payment webhook evidence tables. Before
 * migration 102 there was none at all — their triggers refused DELETE for every
 * role, so provider webhook evidence accumulated forever. Runs as
 * `awcms_mini_worker`, the only role migration 102 grants DELETE to; the
 * request-path role `awcms_mini_app` still cannot delete these rows.
 *
 * Retention resolves from `--retention-days=<n>`, then
 * `PAYMENT_EVIDENCE_RETENTION_DAYS`, then the 400-day default.
 *
 * `--dry-run`: reports active tenants without deleting anything or writing any
 * purge audit event.
 *
 * Pure PostgreSQL operation — no provider call, no network egress. Safe in
 * offline/LAN deployments (and a no-op there, since a deployment with the
 * control plane disabled has no evidence rows to age out).
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry
} from "../src/lib/jobs/job-runner";
import { legalHoldGuardPortAdapter } from "../src/modules/data-lifecycle/application/legal-hold-guard-port-adapter";
import { runPaymentGatewayPurge } from "../src/modules/payment-gateway/application/purge-job";

function resolveRetentionDaysFlag(): number | undefined {
  const flag = process.argv.find((arg) => arg.startsWith("--retention-days="));
  if (!flag) {
    return undefined;
  }
  const parsed = Number(flag.split("=")[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));
  const retentionDays = resolveRetentionDaysFlag();

  try {
    const result = await runJob(
      {
        name: "payment-gateway:purge",
        description:
          "Deletes payment webhook evidence (processing attempts, normalized events, webhook inbox) and reconciliation logs past their retention cutoff for every active tenant, in FK-safe order and bounded batches, honoring legal holds (the delegated data_lifecycle adopter for payment_gateway).",
        handler: async (ctx) => {
          const purgeResult = await runPaymentGatewayPurge(
            sql,
            ctx,
            legalHoldGuardPortAdapter,
            { retentionDays }
          );
          const hitPassLimit = purgeResult.tenantsHitPassLimit.length > 0;
          const heldCount = purgeResult.tenantsUnderLegalHold.length;

          console.log(
            `payment-gateway:purge complete — correlationId=${ctx.correlationId} ` +
              `tenants=${purgeResult.tenantsChecked} attempts=${purgeResult.purgedProcessingAttempts} ` +
              `normalized=${purgeResult.purgedNormalizedEvents} inbox=${purgeResult.purgedWebhookInbox} ` +
              `reconciliations=${purgeResult.purgedReconciliations} cutoff=${purgeResult.cutoffIso}` +
              (ctx.dryRun ? " (dry-run: nothing was purged)" : "") +
              (heldCount > 0
                ? ` (${heldCount} tenant(s) skipped under an active legal hold)`
                : "") +
              (hitPassLimit
                ? ` (WARNING: ${purgeResult.tenantsHitPassLimit.length} tenant(s) still had backlog after the pass-count safety bound)`
                : "")
          );

          return {
            status: hitPassLimit ? "partial" : "success",
            itemCounts: {
              tenantsChecked: purgeResult.tenantsChecked,
              purgedProcessingAttempts: purgeResult.purgedProcessingAttempts,
              purgedNormalizedEvents: purgeResult.purgedNormalizedEvents,
              purgedWebhookInbox: purgeResult.purgedWebhookInbox,
              purgedReconciliations: purgeResult.purgedReconciliations,
              tenantsUnderLegalHold: heldCount,
              tenantsHitPassLimit: purgeResult.tenantsHitPassLimit.length
            },
            detail: hitPassLimit
              ? `Backlog not fully drained for: ${purgeResult.tenantsHitPassLimit.join(", ")}`
              : undefined
          };
        }
      },
      { sql, dryRun: cliOptions.dryRun }
    );

    printJobTelemetry(result);
    await writeJobTelemetry(result, cliOptions.jsonOutputPath);

    if (!isJobResultOk(result)) {
      console.error(formatJobOutcomeLine(result));
    }

    applyJobExitCode(result);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
