/**
 * domain-events-dispatch.ts — `bun run domain-events:dispatch`.
 *
 * Issue #742 (epic `platform-evolution` #738, Wave 1). Internal worker
 * entrypoint for `dispatchDomainEventsForTenant`
 * (`src/modules/domain-event-runtime/application/dispatch-domain-events.ts`)
 * — intended to run on a schedule (cron/systemd timer/k8s CronJob), not
 * exposed over HTTP, same "trusted internal worker" convention every other
 * dispatcher script in this repo already uses (`object-sync-dispatch.ts`,
 * `email-dispatch.ts`, `social-publishing-dispatch.ts`).
 *
 * Built on the shared worker runner from the start (`src/lib/jobs/job-
 * runner.ts`, PR #713/Issue #697 — explicitly reused per this issue's own
 * scope: "claim/dispatch/finalize using the shared worker runner ... reuse
 * it, don't reinvent") — advisory lock (a second concurrent invocation
 * safely skips), timeout + SIGTERM/SIGINT cancellation, `--dry-run`,
 * `--json-output=<path>`, and JSON telemetry all come from `runJob`
 * without this file reimplementing any of it.
 *
 * `iterateTenantsInBatches` (`src/lib/jobs/batching.ts`) generalizes the
 * per-tenant bounded-pass loop: `dispatchDomainEventsForTenant` already
 * returns `{ count }` (the number of deliveries claimed this pass), so a
 * tenant with a large backlog gets multiple passes in one run (bounded by
 * `DEFAULT_MAX_PASSES`, 50) until its backlog is drained or the safety
 * bound is hit — same shape `audit-log-purge.ts`/`modules-sync.ts`
 * established as the 2 representative migrated jobs in PR #713.
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
  dispatchDomainEventsForTenant,
  recordDomainEventBacklogGauges,
  type DispatchDomainEventsResult
} from "../src/modules/domain-event-runtime/application/dispatch-domain-events";
// Side-effect imports (Issue #826) — COMPOSITION ROOT. Every module that
// owns a `domain_event_runtime` consumer registers it from its own
// `infrastructure/domain-event-consumer-registration.ts`; this worker runs
// in its own process and imports none of those modules otherwise, so
// without these lines `dispatchDomainEventsForTenant` (which iterates
// REGISTERED CONSUMERS) would never claim their deliveries — silently, with
// no error and no dead-letter, leaving them `pending` forever. Any new
// registration file must be added here too; enforced by
// `tests/unit/domain-event-consumer-registration-wiring.test.ts`.
import "../src/modules/integration-hub/infrastructure/domain-event-consumer-registration";
import "../src/modules/reporting/infrastructure/domain-event-consumer-registration";

export type DomainEventsDispatchOptions = {
  /** Forwarded to `dispatchDomainEventsForTenant`'s own `limit` (defaults to 25 there). Exposed here so tests can force small batches deterministically. */
  limit?: number;
  now?: Date;
  /** Forwarded to `iterateTenantsInBatches`'s own `maxPasses` (defaults to 50). */
  maxPasses?: number;
};

export type DomainEventsDispatchRunResult = DispatchDomainEventsResult & {
  tenantsChecked: number;
  tenantsHitPassLimit: string[];
};

/**
 * Core logic, extracted from `main()` so
 * `tests/integration/domain-events-dispatch-job.integration.test.ts` can
 * exercise it directly without spawning a subprocess (same pattern
 * `runAuditLogPurge`/`audit-log-purge.ts` established). `--dry-run` is a
 * true read-only preview here — `dispatchDomainEventsForTenant` performs
 * real DB writes (claim + handler + finalize is one atomic unit, see that
 * file's own doc comment), so `dryRun` short-circuits to a plain backlog
 * count instead of calling it at all.
 */
export async function runDomainEventsDispatch(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  options: DomainEventsDispatchOptions = {}
): Promise<DomainEventsDispatchRunResult> {
  const now = options.now ?? new Date();

  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);

    return {
      tenantsChecked: tenants.length,
      claimed: 0,
      consumersProcessed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
      tenantsHitPassLimit: []
    };
  }

  const { tenants, perTenant } = await iterateTenantsInBatches(
    sql,
    async (tenantId) => {
      const result = await dispatchDomainEventsForTenant(sql, tenantId, {
        limit: options.limit,
        now,
        correlationId: ctx.correlationId
      });

      await recordDomainEventBacklogGauges(sql, tenantId);

      return result;
    },
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  const tenantsHitPassLimit = [...perTenant.entries()]
    .filter(([, outcome]) => outcome.hitPassLimit)
    .map(([tenantId]) => tenantId);

  const aggregated = [...perTenant.values()]
    .flatMap((outcome) => outcome.passes)
    .reduce<DispatchDomainEventsResult>(
      (acc, pass) => ({
        consumersProcessed: acc.consumersProcessed + pass.consumersProcessed,
        claimed: acc.claimed + pass.claimed,
        delivered: acc.delivered + pass.delivered,
        retried: acc.retried + pass.retried,
        deadLettered: acc.deadLettered + pass.deadLettered,
        skipped: acc.skipped + pass.skipped
      }),
      {
        consumersProcessed: 0,
        claimed: 0,
        delivered: 0,
        retried: 0,
        deadLettered: 0,
        skipped: 0
      }
    );

  return {
    tenantsChecked: tenants.length,
    tenantsHitPassLimit,
    ...aggregated
  };
}

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 045.
  const sql = getWorkerDatabaseClient();

  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "domain-events:dispatch",
        description:
          "Claims/executes/finalizes due awcms_mini_domain_event_deliveries rows for every active tenant and registered consumer.",
        handler: async (ctx) => {
          const dispatchResult = await runDomainEventsDispatch(sql, ctx);
          const hitPassLimit = dispatchResult.tenantsHitPassLimit.length > 0;

          console.log(
            `domain-events:dispatch complete — correlationId=${ctx.correlationId} ` +
              `tenants=${dispatchResult.tenantsChecked} claimed=${dispatchResult.claimed} ` +
              `delivered=${dispatchResult.delivered} retried=${dispatchResult.retried} ` +
              `deadLettered=${dispatchResult.deadLettered} skipped=${dispatchResult.skipped}` +
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
              deadLettered: dispatchResult.deadLettered,
              skipped: dispatchResult.skipped
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
