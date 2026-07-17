/**
 * Synthetic multi-tenant scale profiles (Issue #744, epic #738
 * platform-evolution). A profile is the single, versioned, documented
 * source of truth for "how much data, spread across how many tenants" a
 * performance run seeds — the issue's own acceptance criterion ("documents
 * row/tenant distributions") is satisfied by these constants being the
 * literal numbers used, not a separate prose description that can drift.
 *
 * Three profiles, one per lane:
 *
 * - `safe`  — the CI/PR-safe subset (`scripts/performance-suite.ts`
 *   default, `scripts/performance-query-plan-check.ts`'s only mode). Small
 *   enough to seed and query in a few seconds, but still large enough for
 *   PostgreSQL's planner to genuinely prefer an Index/Bitmap/Index-Only
 *   Scan for an indexed, tenant-scoped predicate and a Seq Scan for an
 *   unindexed one at the same table size (empirically verified by
 *   `tests/integration/performance-query-plan-check.integration.test.ts`)
 *   — the whole point of the safe lane is that it is a REAL, if small,
 *   proof, not a skipped/mocked one.
 * - `standard` — a moderate scale for manual/ad hoc runs during
 *   performance investigation (bigger than `safe`, still fast enough to
 *   run on a laptop).
 * - `large` — the heavier scheduled/manual full lane
 *   (`--full`), sized to approximate a real multi-tenant production
 *   dataset. Not run as part of `bun run check`/CI on every PR (too slow
 *   by design — see `docs/awcms-mini/performance-suite.md` §Safe subset vs.
 *   full lane).
 *
 * Every profile designates exactly ONE "noisy neighbor" tenant (the last
 * tenant in the plan) whose row counts are multiplied by
 * `noisyNeighborMultiplier` — the issue's own "at least one noisy-neighbor
 * scenario" requirement — so fixture generation and every downstream
 * scenario always has a genuinely skewed tenant distribution to contend
 * with, not just N equally-sized tenants.
 */

export type TableRowCounts = {
  /** `awcms_mini_audit_events` — high-risk-action audit trail. */
  auditEvents: number;
  /** `awcms_mini_abac_decision_logs` — ABAC allow/deny decision log. */
  abacDecisionLogs: number;
  /** `awcms_mini_visitor_sessions` — analytics session shape. */
  visitorSessions: number;
  /** `awcms_mini_sync_outbox` — outbox/delivery event shape. */
  syncOutbox: number;
  /** `awcms_mini_object_sync_queue` — sync/delivery queue shape (also the outbox-claim query-plan budget's driving table). */
  objectSyncQueue: number;
  /** `awcms_mini_idempotency_keys` — idempotency store shape. */
  idempotencyKeys: number;
  /** `awcms_mini_blog_posts` — representative tenant-scoped business/content table (also the full-text search and admin-list query-plan budgets' driving table). */
  blogPosts: number;
  /**
   * `awcms_mini_blog_pages` — the admin **page** list query-plan budget's
   * driving table (Issue #838). Added after Issue #830's
   * `(tenant_id, updated_at DESC)` indexes made an admin-list budget
   * possible: `blog-page-directory.ts`'s `listBlogPagesForAdmin` is a
   * near-verbatim copy of `blog-post-directory.ts`'s post list, so it
   * carries exactly the same regression risk — but this table was not
   * seeded at all before, and a budget over an EMPTY table is a vacuous
   * gate (PostgreSQL Seq Scans a 0-row table no matter what indexes
   * exist). Deliberately smaller than `blogPosts`: a real CMS tenant has
   * far more posts than pages, and this ratio is what the fixture is for.
   */
  blogPages: number;
};

export type PerformanceScaleProfile = {
  id: "safe" | "standard" | "large";
  label: string;
  /** Total tenant count, INCLUDING the one designated noisy-neighbor tenant. */
  tenantCount: number;
  /** Per-normal-tenant row counts (the noisy-neighbor tenant's counts are these x `noisyNeighborMultiplier`). */
  rowsPerTenant: TableRowCounts;
  /** Multiplier applied to the last tenant in the plan's row counts — the noisy-neighbor tenant. */
  noisyNeighborMultiplier: number;
  /** Soak-scenario duration for this profile (0 = soak scenario is skipped at this profile — used by `safe`, which must stay fast). */
  soakDurationMs: number;
};

export const SAFE_SCALE_PROFILE: PerformanceScaleProfile = {
  id: "safe",
  label: "safe (CI/PR-safe subset)",
  tenantCount: 5,
  rowsPerTenant: {
    auditEvents: 1500,
    abacDecisionLogs: 800,
    visitorSessions: 400,
    syncOutbox: 300,
    objectSyncQueue: 300,
    idempotencyKeys: 150,
    blogPosts: 300,
    blogPages: 200
  },
  noisyNeighborMultiplier: 6,
  soakDurationMs: 0
};

export const STANDARD_SCALE_PROFILE: PerformanceScaleProfile = {
  id: "standard",
  label: "standard (manual investigation)",
  tenantCount: 20,
  rowsPerTenant: {
    auditEvents: 15000,
    abacDecisionLogs: 8000,
    visitorSessions: 5000,
    syncOutbox: 4000,
    objectSyncQueue: 4000,
    idempotencyKeys: 2000,
    blogPosts: 2000,
    blogPages: 800
  },
  noisyNeighborMultiplier: 10,
  soakDurationMs: 60_000
};

export const LARGE_SCALE_PROFILE: PerformanceScaleProfile = {
  id: "large",
  label: "large (scheduled/manual full lane)",
  tenantCount: 50,
  rowsPerTenant: {
    auditEvents: 60000,
    abacDecisionLogs: 30000,
    visitorSessions: 20000,
    syncOutbox: 15000,
    objectSyncQueue: 15000,
    idempotencyKeys: 8000,
    blogPosts: 6000,
    blogPages: 2500
  },
  noisyNeighborMultiplier: 15,
  soakDurationMs: 10 * 60_000
};

export const SCALE_PROFILES: Record<
  PerformanceScaleProfile["id"],
  PerformanceScaleProfile
> = {
  safe: SAFE_SCALE_PROFILE,
  standard: STANDARD_SCALE_PROFILE,
  large: LARGE_SCALE_PROFILE
};

export function resolveScaleProfile(
  id: string | undefined
): PerformanceScaleProfile {
  if (id && id in SCALE_PROFILES) {
    return SCALE_PROFILES[id as PerformanceScaleProfile["id"]];
  }

  return SAFE_SCALE_PROFILE;
}

/** Total rows a profile will seed across every tenant/table — for operator-facing "what am I about to seed" summaries. */
export function totalRowCount(profile: PerformanceScaleProfile): number {
  const perTenantTotal = Object.values(profile.rowsPerTenant).reduce(
    (sum, count) => sum + count,
    0
  );
  const normalTenants = profile.tenantCount - 1;

  return (
    perTenantTotal * normalTenants +
    perTenantTotal * profile.noisyNeighborMultiplier
  );
}
