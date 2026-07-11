/**
 * Bounded batching helpers (Issue #697, epic #679, platform-hardening —
 * shared worker runner). Generalizes the `MAX_PASSES_PER_TENANT` loop
 * already duplicated, with small variations, across `scripts/audit-log-
 * purge.ts`, `scripts/form-draft-purge.ts`, `scripts/object-sync-
 * dispatch.ts`, and `scripts/email-dispatch.ts`: call a bounded-size
 * operation repeatedly for one tenant until either a pass affects zero rows
 * (backlog drained) or a safety-bound number of passes is hit (one huge
 * backlog must never make a single scheduled run run forever, or hold one
 * unbounded transaction/memory allocation).
 *
 * This module only decides *when to stop looping* — the actual per-pass row
 * limit (the `LIMIT`/`batchLimit` clause in the underlying SQL) stays owned
 * by each domain function (e.g. `purgeExpiredAuditEvents`'s own
 * `batchLimit` option, `AUDIT_EVENT_PURGE_BATCH_LIMIT`), exactly as before —
 * this is intentionally NOT a second, competing place that also tries to
 * clamp item counts (`scripts/visitor-analytics-purge.ts`'s own header
 * warns against exactly that kind of divergent re-derivation).
 *
 * Adoption is incremental (Issue #697 scope: migrate 2 representative jobs,
 * not all of them) — existing scripts using their own inline
 * `MAX_PASSES_PER_TENANT` loop remain valid and are not required to switch
 * to this helper immediately; see `docs/awcms-mini/deployment-profiles.md`
 * §Shared worker runner.
 */

export type TenantRow = { id: string };

/** Every batched job iterates only `active` tenants — mirrors every existing script's own `SELECT id FROM awcms_mini_tenants WHERE status = 'active'`. `awcms_mini_tenants` itself has no RLS (it is the root table, not tenant-scoped data), so this plain query is safe on any client. */
export async function fetchActiveTenants(sql: Bun.SQL): Promise<TenantRow[]> {
  return (await sql`
    SELECT id FROM awcms_mini_tenants WHERE status = 'active'
  `) as TenantRow[];
}

/** The default safety bound every existing script's own `MAX_PASSES_PER_TENANT` constant already uses (audit-log-purge.ts, form-draft-purge.ts use 50; object-sync-dispatch.ts/email-dispatch.ts use 20). Callers needing a different bound pass their own `maxPasses`. */
export const DEFAULT_MAX_PASSES = 50;

/** The minimal shape a single bounded pass must report: how many items it affected — the loop stops once this is `0`. */
export type BatchPassResult = {
  count: number;
};

export type BoundedBatchOutcome<TResult extends BatchPassResult> = {
  passes: TResult[];
  totalCount: number;
  /** `true` if the safety bound (`maxPasses`) was hit before a pass returned `count: 0` — a signal the backlog was NOT fully drained this run, worth surfacing in job telemetry rather than silently swallowing. */
  hitPassLimit: boolean;
};

/**
 * Repeatedly calls `runPass()` until it reports `count: 0` (backlog
 * drained) or `maxPasses` is reached (safety bound) — whichever comes
 * first. Each call to `runPass()` is expected to be its own bounded
 * transaction/statement (the caller's responsibility, e.g. via
 * `withTenant`); this function only sequences the calls, it never opens a
 * transaction of its own and never accumulates unbounded memory (only the
 * small per-pass result objects are kept, capped at `maxPasses` entries).
 */
export async function runBoundedBatches<TResult extends BatchPassResult>(
  runPass: () => Promise<TResult>,
  options: { maxPasses?: number } = {}
): Promise<BoundedBatchOutcome<TResult>> {
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  const passes: TResult[] = [];
  let totalCount = 0;
  let hitPassLimit = false;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await runPass();
    passes.push(result);
    totalCount += result.count;

    if (result.count === 0) {
      break;
    }

    if (pass === maxPasses - 1) {
      hitPassLimit = true;
    }
  }

  return { passes, totalCount, hitPassLimit };
}

export type TenantBatchOutcome<TResult extends BatchPassResult> =
  BoundedBatchOutcome<TResult>;

/**
 * `runBoundedBatches` applied across every `active` tenant. `runPassForTenant`
 * receives each tenant's id and must return one bounded pass's result (same
 * contract as `runBoundedBatches`); this function loops per tenant until
 * that tenant's backlog is drained or `maxPasses` is hit, then moves to the
 * next tenant — never holding more than one tenant's in-flight pass at a
 * time, and never accumulating results across tenants beyond the small
 * per-tenant `passes` arrays returned in `perTenant`.
 */
export async function iterateTenantsInBatches<TResult extends BatchPassResult>(
  sql: Bun.SQL,
  runPassForTenant: (tenantId: string) => Promise<TResult>,
  options: { maxPasses?: number; tenants?: TenantRow[] } = {}
): Promise<{
  tenants: TenantRow[];
  totalCount: number;
  perTenant: Map<string, TenantBatchOutcome<TResult>>;
}> {
  const tenants = options.tenants ?? (await fetchActiveTenants(sql));
  const perTenant = new Map<string, TenantBatchOutcome<TResult>>();
  let totalCount = 0;

  for (const tenant of tenants) {
    const outcome = await runBoundedBatches(
      () => runPassForTenant(tenant.id),
      options
    );

    perTenant.set(tenant.id, outcome);
    totalCount += outcome.totalCount;
  }

  return { tenants, totalCount, perTenant };
}
