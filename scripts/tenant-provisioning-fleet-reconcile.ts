/**
 * tenant-provisioning-fleet-reconcile.ts — `bun run tenant-provisioning:fleet-reconcile`.
 *
 * Issue #930 (epic #868). The fleet-wide provisioning reconciliation pass.
 *
 * ## The gap this closes, in the module's own words
 *
 * `tenant_provisioning`'s job descriptor said it outright: a fleet-wide batch
 * "is intentionally DEFERRED to #880 (it needs a purpose-built cross-tenant
 * read-model — a platform operator is not a soft super-tenant, ADR-0022 6b);
 * until then reconcile on-demand, one tenant at a time". So reconciliation
 * existed but nothing ran it unless a human remembered to, per tenant, by id —
 * which is not a control that scales past a handful of tenants.
 *
 * Wave 2 of #930 built the cross-tenant read model that deferral was waiting
 * on (`scripts/control-plane-fleet-sweep.ts`), and this pass reuses its exact
 * shape:
 *
 *   1. Enumerate tenants from the GLOBAL tenant directory.
 *   2. Open each tenant's own RLS context and touch only its rows.
 *   3. Aggregate in application memory.
 *
 * No query ever sees two tenants' rows at once, and nothing needs `BYPASSRLS`
 * or a platform claim in a policy predicate — which `bun run
 * rls:platform-claim:check` exists to keep true.
 *
 * ## Reports drift; never fixes it
 *
 * This delegates to the same `reconcileProvisioning` engine the REST endpoint
 * and the per-tenant CLI call, and that engine never auto-fixes (ADR-0022 9).
 * It compares the plan's desired steps against what was actually recorded,
 * writes the difference to the reconciliation record, and stops. Remediation
 * stays a deliberate operator action with its own audit trail — a scheduled
 * job that silently repaired provisioning drift would erase the evidence that
 * anything was ever wrong.
 *
 * It is not, however, read-ONLY, and the distinction matters for the grants in
 * migration 105: a pass records itself (status transition, reconciliation row,
 * `last_reconciled_at`). Without that, an operator cannot tell "reconciled, no
 * drift" from "never reconciled".
 *
 * ## Probe every tenant, then spend the budget on the stalest
 *
 * Two phases, and the order is the whole design. Phase 1 probes every active
 * tenant (a cheap read the pass needs anyway to decide due-ness). Phase 2
 * sorts the due ones by how long they have gone unreconciled and spends the
 * per-run budget on the stalest.
 *
 * The obvious one-phase shape — walk tenants, reconcile until the budget runs
 * out — starves the tail. Tenants enumerate in a stable order, and with a 20h
 * freshness interval on a daily schedule every tenant the previous pass
 * touched is due again by the next tick, so the same head wins the budget
 * forever and tenants past it are NEVER reached. That is not a theoretical
 * concern: the first version of this job had exactly that bug, and
 * `tests/unit/tenant-provisioning-fleet-reconciliation.test.ts` demonstrates
 * it rather than merely asserting the fix.
 *
 * With the sort, the budget can only ever delay a tenant, never strand one:
 * whatever it excludes is by construction the freshest of the due set.
 *
 * ## One tenant's failure never aborts the fleet
 *
 * Each tenant's reconciliation is its own transaction, already committed by
 * the time the next one starts. A tenant that throws is counted and surfaced
 * in the job result rather than swallowed — a swallowed failure here would be
 * indistinguishable from "nothing to reconcile", which is precisely the
 * confusion this job exists to remove.
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
  classifyTenantForReconcile,
  RECONCILE_MAX_TENANTS_PER_RUN,
  selectDueTenants,
  staleBefore as computeStaleBefore
} from "../src/modules/tenant-provisioning/application/fleet-reconciliation";
import { findRequestByTenant } from "../src/modules/tenant-provisioning/application/provisioning-directory";
import { reconcileProvisioning } from "../src/modules/tenant-provisioning/application/provisioning-orchestrator";

async function main(): Promise<void> {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "tenant-provisioning:fleet-reconcile",
        description:
          "Runs the non-destructive desired-vs-actual provisioning reconciliation across every active tenant whose last pass is stale. Reports drift and never auto-fixes.",
        handler: async (ctx) => {
          const now = new Date();
          const cutoff = computeStaleBefore(now);
          const tenants = await fetchActiveTenants(sql);

          let reconciled = 0;
          let consistent = 0;
          let withDrift = 0;
          let driftItems = 0;
          let notProvisioned = 0;
          let stillFresh = 0;
          let failed = 0;
          let skippedAborted = 0;

          // --- Phase 1: probe. Read-only, one short transaction per tenant.
          // Deciding due-ness must not hold a request row locked for the whole
          // pass, so this never uses the FOR UPDATE read the reconcile itself
          // takes.
          const due: {
            tenantId: string;
            requestId: string;
            lastReconciledAt: string | null;
          }[] = [];

          for (const tenant of tenants) {
            if (ctx.signal?.aborted) {
              skippedAborted += 1;
              continue;
            }

            try {
              const request = await withTenant(
                sql,
                tenant.id,
                (tx) => findRequestByTenant(tx, tenant.id),
                { workClass: "maintenance" }
              );

              // Every skip is COUNTED, never silently dropped, so the fleet
              // totals reconcile against the tenant count — an operator can
              // tell "nothing was due" from "everything was deferred".
              const verdict = classifyTenantForReconcile(request, {
                staleBefore: cutoff
              });

              if (verdict.action === "skip") {
                if (verdict.reason === "not_provisioned") notProvisioned += 1;
                else stillFresh += 1;
                continue;
              }

              due.push({
                tenantId: tenant.id,
                requestId: verdict.request.id,
                lastReconciledAt: verdict.request.lastReconciledAt
              });
            } catch (error) {
              failed += 1;
              console.error(
                `tenant-provisioning:fleet-reconcile — probing tenant ${tenant.id} failed: ${safeErrorDetail(error)}`
              );
            }
          }

          // --- Phase 2: spend the budget on the STALEST due tenants.
          const { selected, deferred } = selectDueTenants(
            due,
            RECONCILE_MAX_TENANTS_PER_RUN
          );

          for (const candidate of selected) {
            if (ctx.signal?.aborted) {
              skippedAborted += 1;
              continue;
            }

            // `reconcileProvisioning` WRITES (status transition +
            // reconciliation record + `last_reconciled_at`), so a dry run must
            // never call it. Everything above this line is the identical
            // selection the real pass makes, which is what makes `--dry-run` a
            // real prediction rather than a no-op.
            if (ctx.dryRun) {
              reconciled += 1;
              continue;
            }

            try {
              const outcome = await reconcileProvisioning(
                sql,
                candidate.tenantId,
                candidate.requestId,
                {
                  actorTenantUserId: null,
                  correlationId: ctx.correlationId
                }
              );

              if (!outcome.ok) {
                // Lost a race with an operator action that moved the request
                // out of `provisioned` between the probe and the reconcile.
                // Not a failure: the next pass picks it up.
                notProvisioned += 1;
                continue;
              }

              reconciled += 1;
              if (outcome.status === "drift_detected") {
                withDrift += 1;
                driftItems += outcome.drift.length;
              } else {
                consistent += 1;
              }
            } catch (error) {
              // Counted and surfaced, never swallowed — see the file header.
              // `safeErrorDetail`, and deliberately NOT `logScriptFailure`:
              // that helper sets `process.exitCode = 1` itself, which would
              // fight `applyJobExitCode` below for control of the exit status.
              failed += 1;
              console.error(
                `tenant-provisioning:fleet-reconcile — tenant ${candidate.tenantId} failed: ${safeErrorDetail(error)}`
              );
            }
          }

          const detail =
            failed > 0
              ? `${reconciled} tenant(s) reconciled, ${withDrift} with drift; ${failed} tenant(s) FAILED and were skipped.`
              : `${reconciled} tenant(s) reconciled, ${withDrift} with drift (${driftItems} item(s)); no auto-fix applied.`;

          return {
            itemCounts: {
              tenantsScanned: tenants.length,
              tenantsReconciled: reconciled,
              tenantsConsistent: consistent,
              tenantsWithDrift: withDrift,
              driftItems,
              tenantsNotProvisioned: notProvisioned,
              tenantsStillFresh: stillFresh,
              tenantsDeferred: deferred.length,
              tenantsFailed: failed,
              tenantsSkipped: skippedAborted
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
