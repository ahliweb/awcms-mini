/**
 * Fleet-wide operational signal this module contributes (Issue #930, epic
 * #868). Per-tenant half only — the cross-tenant iteration lives in the
 * composition-root job (ADR-0022 §6b).
 *
 * Deliberately reuses `computeProjectionFreshness` rather than
 * re-implementing a staleness rule in SQL. A second, SQL-side definition of
 * "stale" would drift from the one the read APIs report, and operators would
 * then see an alert firing for a projection the UI calls current — the worst
 * kind of monitoring bug, because it destroys trust in both surfaces.
 */
import { computeProjectionFreshness } from "../domain/freshness";
import { collectProjectionDescriptors } from "../domain/projection-registry";
import type { ModuleDescriptor } from "../../_shared/module-contract";

export type ReportingSignals = {
  /**
   * Counts keyed by the two freshness states that warrant attention.
   * `delayed` is deliberately excluded — it is the expected state between
   * refresh cycles, and counting it would make the gauge permanently
   * non-zero and therefore useless as an alert.
   */
  staleByState: { stale: number; failed: number };
};

export async function collectReportingSignals(
  tx: Bun.SQL,
  modules: readonly ModuleDescriptor[],
  now: Date
): Promise<ReportingSignals> {
  const descriptors = collectProjectionDescriptors(modules);
  if (descriptors.length === 0) {
    return { staleByState: { stale: 0, failed: 0 } };
  }

  const stateRows = (await tx`
    SELECT projection_key, last_success_at, last_attempt_at, consecutive_failures
    FROM awcms_mini_reporting_projection_state
  `) as {
    projection_key: string;
    last_success_at: Date | null;
    last_attempt_at: Date | null;
    consecutive_failures: number;
  }[];

  const runningRebuilds = (await tx`
    SELECT projection_key
    FROM awcms_mini_reporting_rebuild_runs
    WHERE status = 'running'
  `) as { projection_key: string }[];

  const rebuilding = new Set(runningRebuilds.map((row) => row.projection_key));
  const stateByKey = new Map(stateRows.map((row) => [row.projection_key, row]));

  const staleByState = { stale: 0, failed: 0 };

  for (const descriptor of descriptors) {
    const state = stateByKey.get(descriptor.key);
    // A descriptor with NO state row has never run for this tenant. That is
    // reported as stale (via lastSuccessAt === null), not skipped — "never
    // produced a value" is strictly worse than "produced one that is old",
    // and skipping it would hide a projection that was never wired up at all.
    const view = computeProjectionFreshness(
      {
        lastSuccessAt: state?.last_success_at ?? null,
        lastAttemptAt: state?.last_attempt_at ?? null,
        consecutiveFailures: state?.consecutive_failures ?? 0,
        lastErrorMessage: null,
        rebuildInProgress: rebuilding.has(descriptor.key)
      },
      descriptor.freshness,
      now
    );

    if (view.status === "stale") staleByState.stale += 1;
    if (view.status === "failed") staleByState.failed += 1;
  }

  return { staleByState };
}
