/**
 * tenant-entitlement-expiry-sweep.ts — `bun run tenant-entitlement:expiry-sweep`.
 *
 * Issue #930 (epic #868). Closes out entitlement assignments whose validity
 * window has elapsed, across every active tenant.
 *
 * ## Why this exists
 *
 * Wave 1 of #930 shipped the `control_plane_entitlement_expired_unswept` gauge
 * and an SLO built on top of it. Nothing ever drained that backlog — no expiry
 * sweep existed anywhere in the repo — so the alert watched a queue with no
 * consumer and could only climb. This is the consumer.
 *
 * ## What it changes, and what it deliberately does not
 *
 * It records reality; it does not alter anyone's access.
 * `tenant-entitlement/domain/resolution.ts`'s `assignmentActive()` already
 * returns null once `now >= effectiveTo`, so an expired assignment contributes
 * no grants whether or not this has run. Moving the row from `active` to
 * `expired` takes it from "no grants (window closed)" to "no grants (not
 * active)".
 *
 * That distinction matters for how the alert on this metric should be read,
 * and Wave 1 got it wrong: the descriptor called an unswept backlog an
 * access-control incident. It is not one. A tenant does not retain access, and
 * re-subscription is not blocked either (`assignOffer` supersedes the incumbent
 * row in the same transaction). What accumulates is bookkeeping drift —
 * operator listings, commercial reporting, and the entitlement projections all
 * read `status`, so a fleet of `active` rows whose windows closed months ago
 * misstates what the platform is selling. Worth fixing on a schedule; not
 * worth paging anyone at 03:00. The severity in `tenant-entitlement/module.ts`
 * was corrected alongside this script.
 *
 * ## Cross-tenant shape
 *
 * Same as the fleet observation sweep, and for the same reason (ADR-0022 §6b —
 * a platform operator is NOT a soft super-tenant): enumerate tenants from the
 * global directory, then read and write each tenant's rows inside THAT
 * tenant's own RLS context. No query ever sees two tenants' rows at once, and
 * nothing needs `BYPASSRLS`.
 *
 * ## Bounded and idempotent
 *
 * `runJob` holds a per-job-name advisory lock, the per-tenant selection takes
 * `FOR UPDATE SKIP LOCKED` under a `LIMIT`, and the UPDATE re-asserts
 * `status = 'active'` in its own predicate. A tenant that still has expirable
 * rows after its batch limit is reported as truncated and picked up by the
 * next run rather than looped here, so one pathological tenant can never
 * monopolise a pass.
 *
 * Unlike the read-only fleet sweep, a partial run here is FINE to leave
 * partial: every tenant's work is independent and already committed, so one
 * tenant failing must not abort the rest. Failures are counted and surfaced in
 * the job result rather than swallowed.
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
import { safeErrorDetail } from "../src/lib/logging/error-sanitizer";
import {
  countExpirableAssignmentsForTenant,
  DEFAULT_EXPIRY_BATCH_LIMIT,
  sweepExpiredAssignmentsForTenant
} from "../src/modules/tenant-entitlement/application/expiry-sweep";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "tenant-entitlement:expiry-sweep",
        description:
          "Closes out entitlement assignments whose validity window has elapsed, across every active tenant. Bookkeeping only: an expired assignment already contributes no grants, so no tenant's effective access changes.",
        handler: async (ctx) => {
          const now = new Date();
          const tenants = await fetchActiveTenants(sql);

          let expired = 0;
          let tenantsWithWork = 0;
          let tenantsTruncated = 0;
          let tenantsFailed = 0;
          let tenantsSkipped = 0;

          for (const tenant of tenants) {
            if (ctx.signal?.aborted) {
              tenantsSkipped += 1;
              continue;
            }

            try {
              if (ctx.dryRun) {
                // The sweep is a MUTATION, so a dry run must never call it.
                // Count with the identical predicate instead, which is what
                // makes `--dry-run` a real prediction rather than a no-op.
                const pending = await withTenant(
                  sql,
                  tenant.id,
                  (tx) =>
                    countExpirableAssignmentsForTenant(tx, tenant.id, now),
                  { workClass: "maintenance" }
                );
                expired += pending;
                if (pending > 0) tenantsWithWork += 1;
                if (pending >= DEFAULT_EXPIRY_BATCH_LIMIT)
                  tenantsTruncated += 1;
                continue;
              }

              const outcome = await withTenant(
                sql,
                tenant.id,
                (tx) =>
                  sweepExpiredAssignmentsForTenant(tx, tenant.id, {
                    now,
                    correlationId: ctx.correlationId
                  }),
                { workClass: "maintenance" }
              );

              expired += outcome.expired;
              if (outcome.expired > 0) tenantsWithWork += 1;
              if (outcome.truncated) tenantsTruncated += 1;
            } catch (error) {
              // One tenant's failure must not abort the fleet: every tenant's
              // work is independent and already committed. Count it, surface
              // it, and keep going — a swallowed failure here would look
              // identical to "nothing to do".
              tenantsFailed += 1;
              // `safeErrorDetail`, not the raw message, and deliberately NOT
              // `logScriptFailure`: that helper sets `process.exitCode = 1`
              // itself, which would fight `applyJobExitCode` below for control
              // of the exit status. The failure is counted into the job result
              // instead, so the runner decides.
              console.error(
                `tenant-entitlement:expiry-sweep — tenant ${tenant.id} failed: ${safeErrorDetail(error)}`
              );
            }
          }

          const detail =
            tenantsFailed > 0
              ? `${expired} assignment(s) expired; ${tenantsFailed} tenant(s) FAILED and were skipped.`
              : `${expired} assignment(s) expired across ${tenantsWithWork} tenant(s).`;

          return {
            itemCounts: {
              tenantsScanned: tenants.length,
              tenantsWithWork,
              tenantsTruncated,
              tenantsFailed,
              tenantsSkipped,
              assignmentsExpired: expired
            },
            detail
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
