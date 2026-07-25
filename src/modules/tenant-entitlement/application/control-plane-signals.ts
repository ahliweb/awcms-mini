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
   * closed. This is simultaneously a commercial problem (the tenant is not
   * paying for what it holds) and an AUTHORIZATION problem (it retains access
   * it is no longer entitled to), which is why the objective built on it is
   * tight rather than merely eventual.
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
