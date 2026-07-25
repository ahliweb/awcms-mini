/**
 * Fleet-wide operational signal this module contributes (Issue #930, epic
 * #868). Per-tenant half only — see
 * `tenant-provisioning/application/control-plane-signals.ts` for why the
 * cross-tenant iteration lives in the composition-root job rather than here
 * (ADR-0022 §6b: a platform operator is not a soft super-tenant).
 */

export type EntitlementSignals = {
  /**
   * Assignments still marked `active` whose validity window has already
   * closed — i.e. the backlog `bun run tenant-entitlement:expiry-sweep` has
   * yet to close out.
   *
   * NOT an authorization problem, despite how this was originally described
   * (Issue #930 Wave 1). `domain/resolution.ts`'s `assignmentActive()` returns
   * null once `now >= effectiveTo`, so an expired assignment contributes no
   * grants whether or not the sweep has run: the tenant does not retain
   * access. Nor does it block re-subscription — `assignOffer` supersedes the
   * incumbent row inside its own transaction, so an unswept row never occupies
   * the live slot in a way that matters.
   *
   * What it actually measures is BOOKKEEPING DRIFT. Operator listings,
   * commercial reporting, and the entitlement projections all read `status`,
   * so a fleet of `active` rows whose windows closed months ago misstates what
   * the platform is selling. That is worth fixing on a schedule, and worth
   * alerting on when the sweep stops running — but it is not an incident, and
   * the thresholds in `module.ts` are calibrated accordingly.
   */
  expiredUnswept: number;
};

export async function collectEntitlementSignals(
  tx: Bun.SQL,
  now: Date
): Promise<EntitlementSignals> {
  // `effective_to IS NULL` means open-ended, which is never expired — the
  // NULL check has to be explicit, since `NULL < now()` is NULL, not false,
  // and a `NOT (effective_to >= now())` phrasing would silently drop
  // open-ended rows into neither branch.
  const rows = (await tx`
    SELECT count(*)::int AS row_count
    FROM awcms_mini_tenant_entitlement_assignments
    WHERE status = 'active'
      AND effective_to IS NOT NULL
      AND effective_to < ${now}
  `) as { row_count: number }[];

  return { expiredUnswept: rows[0]?.row_count ?? 0 };
}
