/**
 * `LegalHoldGuardPort` (Issue #745, security-auditor finding on PR #773) —
 * the capability `logging`/`visitor_analytics`/`form_drafts` consume from
 * `data_lifecycle`: "is this registered high-volume-table descriptor
 * currently under an active legal hold for this tenant?" Lives in neutral
 * ground (`_shared`, imports NOTHING from either module), same reasoning
 * `social-publishing-port.ts`/`news-media-port.ts`/`public-content-port.ts`
 * document in their own headers.
 *
 * Exists because each of these 3 modules' OWN existing purge function
 * (`purgeExpiredAuditEvents`/`purgeVisitorAnalyticsData`/
 * `purgeExpiredFormDrafts`) is the real, only enforcement point for "an
 * active legal hold overrides ordinary retention/purge and cannot be
 * silently bypassed" for its own registered `dataLifecycle` descriptor —
 * `data_lifecycle`'s own archive/purge engine NEVER mutates a "delegated"
 * descriptor's table (see `data-lifecycle/application/archive-purge-job.ts`
 * header comment), it only records a read-only dry-run snapshot. But
 * importing `data_lifecycle`'s `application`/`domain` code DIRECTLY from
 * these 3 modules' own `application`/`domain` trees would create exactly
 * the circular cross-module import
 * `tests/unit/module-boundary-cycles.test.ts` (Issue #685/ADR-0011)
 * forbids: `data_lifecycle` already imports `logging`'s `recordAuditEvent`
 * (to audit its own operations), so `logging` importing `data_lifecycle`'s
 * code back would complete a real cycle.
 *
 * The concrete implementation
 * (`data-lifecycle/application/legal-hold-guard-port-adapter.ts`) is a thin
 * wrapper around `fetchActiveLegalHoldsForPlanning`/
 * `evaluateLegalHoldForDescriptor`. Only the TRUE composition roots — each
 * purge job's own script (`scripts/audit-log-purge.ts`,
 * `scripts/visitor-analytics-purge.ts`, `scripts/form-draft-purge.ts`), the
 * one on-demand API route that also calls `purgeVisitorAnalyticsData`
 * directly (`src/pages/api/v1/analytics/retention/purge.ts`), and
 * integration tests exercising these functions directly — import both the
 * concrete adapter and the purge function, wiring them together. None of
 * those live inside any module's `application`/`domain` tree, so none are
 * scanned by the forbidden-cross-import gate.
 */
export type LegalHoldGuardPort = {
  /**
   * True if `descriptorKey` currently has an active legal hold for this
   * tenant — either a hold scoped exactly to `descriptorKey`, or a broader
   * tenant-wide hold (`descriptorKey: null` at creation time). See
   * `data_lifecycle/domain/legal-hold.ts`'s `evaluateLegalHoldForDescriptor`
   * for the exact precedence rule this wraps. `tx` must already be
   * tenant-scoped (via `withTenant`) — this reads
   * `awcms_mini_data_lifecycle_legal_holds`, itself `FORCE ROW LEVEL
   * SECURITY`'d.
   */
  isDescriptorHeld(
    tx: Bun.SQL,
    tenantId: string,
    descriptorKey: string
  ): Promise<boolean>;
};
