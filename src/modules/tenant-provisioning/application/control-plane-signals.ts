/**
 * Fleet-wide operational signals this module contributes (Issue #930, epic
 * #868).
 *
 * ## Why this lives here and not in a central collector
 *
 * ADR-0022 §6b: a platform operator is NOT a soft super-tenant, and nothing
 * scans every tenant's RLS tables ad hoc. The cross-tenant read model is
 * therefore built the only safe way — enumerate tenants from the global
 * tenant directory, then read each tenant's own rows INSIDE that tenant's RLS
 * context, one at a time. `collectProvisioningSignals` is the per-tenant half
 * and takes an already-tenant-scoped transaction; the iteration half lives in
 * the composition-root job (`scripts/control-plane-fleet-sweep.ts`), which is
 * also the only place allowed to import several modules' collectors at once.
 *
 * Keeping the query in the OWNING module means no other module ever reaches
 * into `awcms_mini_tenant_provisioning_*` — the same boundary rule
 * `dataLifecycle` and `reportingProjections` descriptors exist to preserve.
 */

/**
 * Provisioning request statuses that are NOT terminal — the population a
 * backlog objective is about. `provisioned` and `canceled` are terminal
 * successes/withdrawals; `failed` is terminal but still needs an operator, so
 * it is reported under its own label rather than dropped.
 */
const NON_TERMINAL_STATUSES = [
  "requested",
  "in_progress",
  "compensating",
  "blocked",
  "reconciling"
] as const;

/**
 * Maps this module's own request status vocabulary onto the bounded,
 * code-defined `attemptStatus` label the `control_plane_provisioning_backlog`
 * metric declares. The metric's label set is deliberately COARSER than the
 * status enum: an alert dimension that grew every time this module added a
 * status would be a cardinality leak waiting to happen, and an operator
 * responding to a page needs "is it moving / is it waiting on a human / did
 * it fail", not the internal state name.
 */
export function toAttemptStatusLabel(status: string): string {
  switch (status) {
    case "requested":
      return "pending";
    case "in_progress":
    case "compensating":
    case "reconciling":
      return "running";
    case "blocked":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export type ProvisioningSignals = {
  /** Non-terminal request counts, already mapped to the metric's label vocabulary. */
  backlogByAttemptStatus: Record<string, number>;
  /**
   * Age of the oldest non-terminal request in seconds, or `null` when there
   * is no backlog. Depth alone cannot distinguish a healthy queue that is
   * briefly deep from a stalled one that is permanently shallow — this can.
   */
  oldestPendingSeconds: number | null;
  /** Requests parked awaiting a human decision (`blocked`). */
  manualInterventionCount: number;
};

export async function collectProvisioningSignals(
  tx: Bun.SQL,
  now: Date
): Promise<ProvisioningSignals> {
  const rows = (await tx`
    SELECT status,
           count(*)::int AS row_count,
           min(requested_at) AS oldest_requested_at
    FROM awcms_mini_tenant_provisioning_requests
    WHERE status = ANY(${tx.array([...NON_TERMINAL_STATUSES, "failed"], "text")})
    GROUP BY status
  `) as {
    status: string;
    row_count: number;
    oldest_requested_at: Date | null;
  }[];

  const backlogByAttemptStatus: Record<string, number> = {};
  let oldestPendingMs: number | null = null;
  let manualInterventionCount = 0;

  for (const row of rows) {
    const label = toAttemptStatusLabel(row.status);
    backlogByAttemptStatus[label] =
      (backlogByAttemptStatus[label] ?? 0) + row.row_count;

    if (row.status === "blocked") {
      manualInterventionCount += row.row_count;
    }

    // `failed` is excluded from the AGE signal on purpose: a failed request
    // stops aging in any meaningful sense (it is not waiting on anything), so
    // including it would make the oldest-pending age grow forever after a
    // single failure and permanently pin the alert.
    if (row.status !== "failed" && row.oldest_requested_at !== null) {
      const ms = row.oldest_requested_at.getTime();
      oldestPendingMs =
        oldestPendingMs === null ? ms : Math.min(oldestPendingMs, ms);
    }
  }

  return {
    backlogByAttemptStatus,
    oldestPendingSeconds:
      oldestPendingMs === null
        ? null
        : Math.max(0, (now.getTime() - oldestPendingMs) / 1000),
    manualInterventionCount
  };
}
