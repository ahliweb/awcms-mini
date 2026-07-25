/**
 * Fleet reconciliation scheduling policy (Issue #930, epic #868).
 *
 * The decisions "is THIS tenant due?" and "which of the due tenants does this
 * pass actually spend its budget on?" — extracted from
 * `scripts/tenant-provisioning-fleet-reconcile.ts` so they can be tested
 * without a database, the same split Wave 2 used for the fleet observation
 * sweep (iteration in the composition root, logic in a module).
 *
 * There is no database access in this file and there must never be: the
 * cross-tenant iteration stays in the script, because a platform operator is
 * not a soft super-tenant (ADR-0022 §6b).
 *
 * ## Why the budget is a SORT, not an early exit
 *
 * The obvious shape — walk tenants, reconcile until the budget runs out — is
 * wrong, and the unit tests demonstrate it rather than assert it. Tenants are
 * enumerated in a stable order, and the freshness filter does not rescue that
 * on its own: with a 20h interval and a daily schedule, every tenant the
 * previous pass reconciled is due again by the time the next pass starts, so
 * an early-exit loop re-reconciles the same head of the list on every run and
 * the tail is NEVER reached. Not "reached late" — never.
 *
 * So the pass probes every tenant first (a cheap read it has to do anyway to
 * decide due-ness), then spends its budget on the STALEST tenants: least
 * recently reconciled first, never-reconciled ahead of all of them. That makes
 * starvation impossible by construction rather than by hoping the cadence and
 * the interval happen to line up.
 */
import type { ProvisioningRequestDto } from "./provisioning-directory";

/**
 * Skip a tenant reconciled more recently than this.
 *
 * 20 hours rather than 24 for a daily schedule: cron ticks drift, and a run
 * that starts a few minutes later than the previous one must not skip the
 * tenant it reconciled just under 24h ago — that would silently halve the
 * effective cadence for every tenant on the fleet.
 */
export const RECONCILE_MIN_INTERVAL_HOURS = 20;

/**
 * Upper bound on tenants actually reconciled per pass — a lock-footprint and
 * run-duration control, not a correctness one. Whatever it excludes is by
 * construction the FRESHEST of the due tenants (see the header), so it can
 * only ever delay work, never strand it.
 */
export const RECONCILE_MAX_TENANTS_PER_RUN = 200;

export type ReconcileVerdict<T> =
  /** No provisioning run, or one that is not in `provisioned` — nothing to reconcile. */
  | { action: "skip"; reason: "not_provisioned" }
  /** Reconciled recently enough; leave it for a later pass. */
  | { action: "skip"; reason: "still_fresh" }
  /**
   * Due. Carries the request it applies to so the caller reaches
   * `request.id` without a non-null assertion — the "is this reconcilable?"
   * check and the "reconcile it" call cannot drift into two independent
   * conditions.
   */
  | { action: "due"; request: T };

/**
 * Decide whether one tenant's provisioning request is due for reconciliation.
 *
 * Reconcilability is checked before freshness, deliberately: a tenant that is
 * mid-provisioning must be reported as `not_provisioned` rather than hidden
 * behind a stale timestamp from a previous life, or the counters describe the
 * wrong reason for doing nothing.
 *
 * The per-run budget is NOT applied here — see `selectDueTenants`.
 */
export function classifyTenantForReconcile<
  T extends Pick<ProvisioningRequestDto, "status" | "lastReconciledAt">
>(request: T | null, ctx: { staleBefore: Date }): ReconcileVerdict<T> {
  if (!request || request.status !== "provisioned") {
    return { action: "skip", reason: "not_provisioned" };
  }

  if (
    request.lastReconciledAt !== null &&
    new Date(request.lastReconciledAt) > ctx.staleBefore
  ) {
    return { action: "skip", reason: "still_fresh" };
  }

  return { action: "due", request };
}

/**
 * Spend the pass's budget on the STALEST due tenants: never-reconciled first,
 * then least-recently-reconciled. Returns the tenants to reconcile now and the
 * ones deferred to a later pass, so the caller can report both rather than
 * silently truncating.
 *
 * Sorting here — not slicing a stable enumeration — is what makes the pass
 * rotate. See the file header for the starvation this prevents.
 */
export function selectDueTenants<
  T extends Pick<ProvisioningRequestDto, "lastReconciledAt">
>(
  due: readonly T[],
  maxTenants: number = RECONCILE_MAX_TENANTS_PER_RUN
): { selected: T[]; deferred: T[] } {
  const ordered = [...due].sort((a, b) => {
    // A tenant that has NEVER been reconciled outranks every tenant that has:
    // it is the one an operator is most likely to be wrong about.
    if (a.lastReconciledAt === null && b.lastReconciledAt === null) return 0;
    if (a.lastReconciledAt === null) return -1;
    if (b.lastReconciledAt === null) return 1;
    return (
      new Date(a.lastReconciledAt).getTime() -
      new Date(b.lastReconciledAt).getTime()
    );
  });

  return {
    selected: ordered.slice(0, Math.max(0, maxTenants)),
    deferred: ordered.slice(Math.max(0, maxTenants))
  };
}

/** The cutoff a pass starting at `now` should treat as "reconciled recently enough". */
export function staleBefore(
  now: Date,
  intervalHours: number = RECONCILE_MIN_INTERVAL_HOURS
): Date {
  return new Date(now.getTime() - intervalHours * 60 * 60 * 1000);
}
