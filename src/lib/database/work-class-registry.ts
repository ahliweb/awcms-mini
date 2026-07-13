/**
 * Job-side work-class registry (Issue #743, epic #738 platform-evolution).
 * Complements the ROUTE-side registry, which is entirely GENERATED (see
 * `scripts/work-class-registry-generate.ts` — every `src/pages/api/v1/**`
 * route that calls `withTenant(...)` already declares its work class
 * inline, either explicitly or by relying on the documented default, so
 * generating a snapshot from that source is strictly more reliable than a
 * second hand-maintained copy).
 *
 * Background jobs (`scripts/*.ts` that call `getWorkerDatabaseClient()`/
 * `getSetupDatabaseClient()`) have no equivalent inline declaration — they
 * do not call `withTenant`/`acquireWorkClassSlot` at all today (see below),
 * so there is nothing to generate FROM. This is therefore a small,
 * hand-authored, DECLARATIVE map: which work-class "bucket" each job's
 * connection usage should be attributed to for the capacity model/registry
 * drift gate, not proof that the job runtime-enforces that class today.
 *
 * ## Why jobs are not runtime-gated through work-class.ts (yet)
 *
 * Retrofitting all 9 worker scripts to call `acquireWorkClassSlot` around
 * their main loop is a real, separately-scoped follow-up (see
 * `docs/awcms-mini/database-capacity-runbook.md` §Known limitation), not
 * done in Issue #743: job concurrency is already bounded by a DIFFERENT,
 * already-existing mechanism — `src/lib/jobs/job-runner.ts`'s Postgres
 * advisory lock ensures at most ONE instance of a given job NAME runs
 * cluster-wide at a time, which is the dominant connection-storm risk for
 * scheduled jobs (an overlapping re-run of the SAME job, e.g. a slow purge
 * still running when the next cron tick fires). This registry still
 * requires every worker script to be explicitly classified — closing the
 * "every database-using process is included in the capacity model, or
 * explicitly exempted with rationale" gap — without also taking on a
 * runtime behavior change to 9 already-shipped scripts in the same issue.
 *
 * `scripts/work-class-registry-check.ts` discovers the CURRENT set of
 * worker scripts by grepping `scripts/*.ts` for `getWorkerDatabaseClient(`/
 * `getSetupDatabaseClient(` (ground truth — independent of whether a
 * module's `jobs:` descriptor also happens to list the script) and fails if
 * any discovered file is missing from this map, or if this map contains a
 * stale entry for a file that no longer exists/no longer opens a worker
 * connection.
 */
import type { WorkClass } from "./work-class";

export type JobWorkClassEntry = {
  workClass: WorkClass;
  rationale: string;
};

/**
 * Keyed by path relative to the repo root. Add an entry here (and re-run
 * `bun run db:work-class:check`) whenever a new `scripts/*.ts` file starts
 * calling `getWorkerDatabaseClient()`/`getSetupDatabaseClient()`.
 */
export const JOB_WORK_CLASS_REGISTRY: Readonly<
  Record<string, JobWorkClassEntry>
> = {
  "scripts/audit-log-purge.ts": {
    workClass: "maintenance",
    rationale:
      "Scheduled retention purge (logs:audit:purge) — tolerant of delay, never latency-sensitive."
  },
  "scripts/form-draft-purge.ts": {
    workClass: "maintenance",
    rationale:
      "Scheduled retention purge (form-drafts:purge) — same profile as audit-log-purge."
  },
  "scripts/visitor-analytics-purge.ts": {
    workClass: "maintenance",
    rationale:
      "Scheduled retention/anonymization purge (analytics:purge) — tolerant of delay."
  },
  "scripts/visitor-analytics-rollup.ts": {
    workClass: "background_sync",
    rationale:
      "Frequent scheduled aggregation (analytics:rollup, doc recommends every run of the daily rollup) — same low-priority-but-regular profile as sync push/pull, not a one-off maintenance task."
  },
  "scripts/email-dispatch.ts": {
    workClass: "background_sync",
    rationale:
      "Outbox dispatcher (email:dispatch), recommended every 1-2 minutes — matches sync/object dispatch's own background_sync classification."
  },
  "scripts/object-sync-dispatch.ts": {
    workClass: "background_sync",
    rationale:
      "Outbox dispatcher (sync:objects:dispatch) — the module's own module.ts already documents this as background/low-priority traffic."
  },
  "scripts/social-publish-dispatch.ts": {
    workClass: "background_sync",
    rationale:
      "Outbox dispatcher (social-publishing:dispatch) — same recurring dispatcher profile."
  },
  "scripts/domain-events-dispatch.ts": {
    workClass: "background_sync",
    rationale:
      'Outbox dispatcher (domain-events:dispatch, Issue #742), recommended every 30-60 seconds — same recurring dispatcher profile as email/object-sync/social-publish dispatch; its own internal withTenant calls already pass workClass: "background_sync" explicitly.'
  },
  "scripts/blog-scheduled-publish.ts": {
    workClass: "background_sync",
    rationale:
      "Scheduled-publish dispatcher (blog:publish:scheduled) — recurring, not latency-sensitive, but more time-relevant than a maintenance purge."
  },
  "scripts/news-media-r2-reconcile.ts": {
    workClass: "maintenance",
    rationale:
      "Infrequent reconciliation sweep (news-media:reconcile) — tolerant of delay, run far less often than the dispatchers above."
  }
};
