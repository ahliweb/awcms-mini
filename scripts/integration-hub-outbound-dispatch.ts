/**
 * integration-hub-outbound-dispatch.ts — `bun run
 * integration-hub:outbound:dispatch`.
 *
 * Issue #754 (epic `platform-evolution` #738, Wave 3). Internal worker
 * entrypoint for `dispatchOutboundQueue`
 * (`src/modules/integration-hub/application/outbound-dispatch.ts`) —
 * scheduled (cron/systemd timer), never exposed over HTTP, same "trusted
 * internal worker" convention every other dispatcher script in this repo
 * uses (`email-dispatch.ts`, `domain-events-dispatch.ts`).
 *
 * Built on the shared worker runner from the start (`src/lib/jobs/job-
 * runner.ts`, PR #713/Issue #697), same shape `domain-events-dispatch.ts`
 * already established: advisory lock, timeout + SIGTERM/SIGINT
 * cancellation, `--dry-run`, `--json-output=<path>`, JSON telemetry, and
 * `iterateTenantsInBatches` for a bounded per-tenant backlog-drain loop.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import {
  fetchActiveTenants,
  iterateTenantsInBatches
} from "../src/lib/jobs/batching";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry,
  type JobContext
} from "../src/lib/jobs/job-runner";
import {
  dispatchOutboundQueue,
  type DispatchOutboundQueueResult
} from "../src/modules/integration-hub/application/outbound-dispatch";

export type IntegrationHubOutboundDispatchOptions = {
  limit?: number;
  now?: Date;
  maxPasses?: number;
};

export type IntegrationHubOutboundDispatchRunResult = Omit<
  DispatchOutboundQueueResult,
  "count"
> & {
  tenantsChecked: number;
  tenantsHitPassLimit: string[];
};

export async function runIntegrationHubOutboundDispatch(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  options: IntegrationHubOutboundDispatchOptions = {}
): Promise<IntegrationHubOutboundDispatchRunResult> {
  const now = options.now ?? new Date();

  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);

    return {
      tenantsChecked: tenants.length,
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      skippedNoSubscription: 0,
      tenantsHitPassLimit: []
    };
  }

  const { tenants, perTenant } = await iterateTenantsInBatches(
    sql,
    (tenantId) =>
      dispatchOutboundQueue(sql, tenantId, {
        limit: options.limit,
        now,
        correlationId: ctx.correlationId
      }),
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  const tenantsHitPassLimit = [...perTenant.entries()]
    .filter(([, outcome]) => outcome.hitPassLimit)
    .map(([tenantId]) => tenantId);

  const aggregated = [...perTenant.values()]
    .flatMap((outcome) => outcome.passes)
    .reduce(
      (acc, pass) => ({
        claimed: acc.claimed + pass.claimed,
        delivered: acc.delivered + pass.delivered,
        retried: acc.retried + pass.retried,
        deadLettered: acc.deadLettered + pass.deadLettered,
        skippedNoSubscription:
          acc.skippedNoSubscription + pass.skippedNoSubscription
      }),
      {
        claimed: 0,
        delivered: 0,
        retried: 0,
        deadLettered: 0,
        skippedNoSubscription: 0
      }
    );

  return {
    tenantsChecked: tenants.length,
    tenantsHitPassLimit,
    ...aggregated
  };
}

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 066.
  const sql = getWorkerDatabaseClient();

  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "integration-hub:outbound:dispatch",
        description:
          "Claims/sends/finalizes due awcms_mini_integration_outbound_deliveries rows for every active tenant's active subscriptions.",
        handler: async (ctx) => {
          const dispatchResult = await runIntegrationHubOutboundDispatch(
            sql,
            ctx
          );
          const hitPassLimit = dispatchResult.tenantsHitPassLimit.length > 0;

          console.log(
            `integration-hub:outbound:dispatch complete — correlationId=${ctx.correlationId} ` +
              `tenants=${dispatchResult.tenantsChecked} claimed=${dispatchResult.claimed} ` +
              `delivered=${dispatchResult.delivered} retried=${dispatchResult.retried} ` +
              `deadLettered=${dispatchResult.deadLettered}` +
              (ctx.dryRun ? " (dry-run: nothing was dispatched)" : "") +
              (hitPassLimit
                ? ` (WARNING: ${dispatchResult.tenantsHitPassLimit.length} tenant(s) still had backlog remaining after the pass-count safety bound)`
                : "")
          );

          return {
            status: hitPassLimit ? "partial" : "success",
            itemCounts: {
              tenantsChecked: dispatchResult.tenantsChecked,
              claimed: dispatchResult.claimed,
              delivered: dispatchResult.delivered,
              retried: dispatchResult.retried,
              deadLettered: dispatchResult.deadLettered
            },
            detail: hitPassLimit
              ? `Backlog not fully drained for: ${dispatchResult.tenantsHitPassLimit.join(", ")}`
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
