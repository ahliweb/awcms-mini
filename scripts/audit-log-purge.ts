/**
 * audit-log-purge.ts — `bun run logs:audit:purge`.
 *
 * Issue #447 (M9 — activating the logging system: correlation ID
 * propagation, audit log retention/purge, observability extension points).
 * Internal worker entrypoint for `purgeExpiredAuditEvents`
 * (`src/modules/logging/application/audit-purge.ts`) — intended to be run
 * on a schedule (cron/systemd timer/k8s CronJob), the same pattern as
 * `scripts/object-sync-dispatch.ts` (Issue #436): not exposed over HTTP,
 * because `awcms_mini_audit_events` retention/purge is an administrative
 * operation, not something any tenant-scoped role should be able to trigger
 * over the API (doc 04 §Aturan implementasi — purge is for "retention/legal
 * hold yang memenuhi syarat", an operational decision, not a user action).
 *
 * Migrated to the shared worker runner (`src/lib/jobs/job-runner.ts`, Issue
 * #697, epic #679) as one of the 2 representative jobs the issue asks for —
 * chosen because it is the canonical "tenant-iterating maintenance job with
 * bounded per-tenant batching" shape (`iterateTenantsInBatches` below is a
 * direct generalization of the `MAX_PASSES_PER_TENANT` loop this script used
 * to hand-roll). Behavior for a normal (non-dry-run) invocation is
 * UNCHANGED: same retention resolution, same `purgeExpiredAuditEvents` call
 * per tenant per pass, same bounded-batch stop condition (a pass purging
 * zero rows, or the same 50-pass safety bound `DEFAULT_MAX_PASSES` in
 * `batching.ts` already matches) — only the orchestration (lock, timeout,
 * correlation id, exit code, JSON telemetry) moved into the shared runner.
 *
 * New on top of the pre-migration behavior:
 * - **Advisory lock** (`bun run logs:audit:purge` run twice concurrently:
 *   the second instance now safely skips instead of both purging the same
 *   backlog at once).
 * - **`--dry-run`**: counts what WOULD be purged (a read-only
 *   `count(*)` per tenant against the same cutoff) without deleting
 *   anything or writing any purge audit event — safe to run in production
 *   to preview impact before scheduling for real.
 * - **`--json-output=<path>`**: structured, redacted run telemetry, same
 *   pattern as `scripts/production-preflight.ts`.
 *
 * Retention is configurable per run, in this priority order: `--retention-
 * days=<n>` CLI flag, then `AUDIT_LOG_RETENTION_DAYS` env var (doc 18), then
 * `AUDIT_EVENT_DEFAULT_RETENTION_DAYS` (730 days / 2 years).
 *
 * PR #713 security review follow-up (Issue #697):
 * - `iterateTenantsInBatches` is now given `ctx.signal`, so a timeout/
 *   SIGTERM/SIGINT stops this job's tenant loop promptly (before the NEXT
 *   pass/tenant starts) instead of running to full completion in the
 *   background — see `src/lib/jobs/batching.ts`'s file header and
 *   `job-runner.ts`'s `runJob` doc comment for the full cancellation model
 *   (this cooperative check narrows, but `runJob`'s own grace-period-bound
 *   lock hold is what actually closes, the mutual-exclusion gap).
 * - A tenant that hits the pass-count safety bound (`hitPassLimit`,
 *   `batching.ts`) — meaning its backlog was NOT fully drained this run —
 *   is now surfaced in `AuditLogPurgeResult.tenantsHitPassLimit` and makes
 *   the job report `status: "partial"` instead of `"success"`, so an
 *   operator's telemetry/monitoring actually sees it, rather than it being
 *   silently swallowed.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { withTenant } from "../src/lib/database/tenant-context";
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
  fetchActiveTenants,
  iterateTenantsInBatches
} from "../src/lib/jobs/batching";
import {
  AUDIT_EVENT_DEFAULT_RETENTION_DAYS,
  purgeExpiredAuditEvents
} from "../src/modules/logging/application/audit-purge";

function resolveRetentionDays(): number {
  const flag = process.argv.find((arg) => arg.startsWith("--retention-days="));

  if (flag) {
    const parsed = Number(flag.split("=")[1]);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const envValue = process.env.AUDIT_LOG_RETENTION_DAYS;

  if (envValue) {
    const parsed = Number(envValue);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return AUDIT_EVENT_DEFAULT_RETENTION_DAYS;
}

export type AuditLogPurgeOptions = {
  /** Defaults to `resolveRetentionDays()` (reads CLI/env). */
  retentionDays?: number;
  /** Defaults to `new Date()`. Injectable for deterministic tests. */
  now?: Date;
  /** Forwarded to `purgeExpiredAuditEvents`'s own `batchLimit` (defaults to `AUDIT_EVENT_PURGE_BATCH_LIMIT`). Exposed here so tests can force a small per-pass limit and assert `iterateTenantsInBatches` correctly loops multiple bounded passes — not a new CLI flag, the production default is unchanged. */
  batchLimit?: number;
  /** Forwarded to `iterateTenantsInBatches`'s own `maxPasses` (defaults to `DEFAULT_MAX_PASSES`, 50). Exposed here so tests can force `hitPassLimit`/`status: "partial"` deterministically with a tiny seed, without needing tens of thousands of rows — not a new CLI flag, the production default is unchanged. */
  maxPasses?: number;
};

export type AuditLogPurgeResult = {
  tenantsChecked: number;
  totalPurged: number;
  cutoffIso: string;
  /** Tenant ids whose backlog was NOT fully drained this run (hit `batching.ts`'s pass-count safety bound) — PR #713 review follow-up, previously computed but silently discarded. Non-empty makes the job report `status: "partial"`. */
  tenantsHitPassLimit: string[];
};

/**
 * Read-only preview for `--dry-run`: a `count(*)` per tenant against the
 * exact same cutoff `purgeExpiredAuditEvents` would use, no `DELETE`, no
 * purge audit event. Deliberately duplicates only the cutoff arithmetic (a
 * one-line computation), not `purgeExpiredAuditEvents`'s own batching/audit
 * logic — so a dry run can never drift from what a real run would compute
 * as "past retention".
 */
async function countPurgeableForTenant(
  sql: Bun.SQL,
  tenantId: string,
  cutoff: Date
): Promise<number> {
  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT count(*)::int AS count
        FROM awcms_mini_audit_events
        WHERE tenant_id = ${tenantId} AND created_at < ${cutoff}
      `) as { count: number }[];

      return rows[0]?.count ?? 0;
    },
    { workClass: "maintenance" }
  );
}

/**
 * Core logic, extracted from `main()` so
 * `tests/integration/audit-log-purge-job.integration.test.ts` can exercise
 * it directly (real tenant iteration + dry-run/real-run parity) without
 * spawning a subprocess, same pattern
 * `purgeVisitorAnalyticsForAllTenants` (`scripts/visitor-analytics-purge.ts`)
 * already established.
 */
export async function runAuditLogPurge(
  sql: Bun.SQL,
  ctx: Pick<JobContext, "dryRun" | "correlationId"> &
    Partial<Pick<JobContext, "signal">>,
  options: AuditLogPurgeOptions = {}
): Promise<AuditLogPurgeResult> {
  const retentionDays = options.retentionDays ?? resolveRetentionDays();
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  if (ctx.dryRun) {
    const tenants = await fetchActiveTenants(sql);
    let totalWouldPurge = 0;

    for (const tenant of tenants) {
      if (ctx.signal?.aborted) {
        break;
      }
      totalWouldPurge += await countPurgeableForTenant(sql, tenant.id, cutoff);
    }

    return {
      tenantsChecked: tenants.length,
      totalPurged: totalWouldPurge,
      cutoffIso: cutoff.toISOString(),
      tenantsHitPassLimit: []
    };
  }

  let cutoffIso = cutoff.toISOString();

  const { tenants, totalCount, perTenant } = await iterateTenantsInBatches(
    sql,
    async (tenantId) => {
      const result = await purgeExpiredAuditEvents(sql, tenantId, {
        retentionDays,
        now,
        batchLimit: options.batchLimit,
        correlationId: ctx.correlationId
      });

      cutoffIso = result.cutoff.toISOString();
      return { count: result.purgedCount };
    },
    { signal: ctx.signal, maxPasses: options.maxPasses }
  );

  const tenantsHitPassLimit = [...perTenant.entries()]
    .filter(([, outcome]) => outcome.hitPassLimit)
    .map(([tenantId]) => tenantId);

  return {
    tenantsChecked: tenants.length,
    totalPurged: totalCount,
    cutoffIso,
    tenantsHitPassLimit
  };
}

async function main() {
  // Issue #683 (epic #679): `awcms_mini_worker` role — see migration 045.
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));
  // Resolved once here (not inside runAuditLogPurge's default) purely so
  // the completion log line below can print it — restores parity with the
  // pre-migration script's own `retentionDays=${retentionDays}` log field
  // (PR #713 review follow-up).
  const retentionDays = resolveRetentionDays();

  try {
    const result = await runJob(
      {
        name: "logs:audit:purge",
        description:
          "Purges awcms_mini_audit_events rows past retention for every active tenant.",
        handler: async (ctx) => {
          const purgeResult = await runAuditLogPurge(sql, ctx, {
            retentionDays
          });
          const hitPassLimit = purgeResult.tenantsHitPassLimit.length > 0;

          console.log(
            `logs:audit:purge complete — correlationId=${ctx.correlationId} ` +
              `retentionDays=${retentionDays} cutoff=${purgeResult.cutoffIso} ` +
              `tenants=${purgeResult.tenantsChecked} purged=${purgeResult.totalPurged}` +
              (ctx.dryRun ? " (dry-run: nothing was deleted)" : "") +
              (hitPassLimit
                ? ` (WARNING: ${purgeResult.tenantsHitPassLimit.length} tenant(s) still had backlog remaining after the pass-count safety bound)`
                : "")
          );

          return {
            status: hitPassLimit ? "partial" : "success",
            itemCounts: {
              tenantsChecked: purgeResult.tenantsChecked,
              purged: purgeResult.totalPurged,
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
