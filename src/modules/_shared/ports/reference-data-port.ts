/**
 * `ReferenceDataPort` (Issue #750, epic #738 platform-evolution Wave 3,
 * ADR-0021). The capability other modules MAY consume (`optional: true`,
 * ADR-0011) to resolve reference codes and safe value-set snapshots
 * WITHOUT ever importing `reference_data`'s tables/application code
 * directly (ADR-0013 §6 no-shared-table-write) — same ports-and-adapters
 * shape `BusinessScopeHierarchyPort` already establishes for
 * `organization_structure`.
 *
 * `reference_data` PROVIDES the only real adapter today
 * (`reference-data/application/reference-data-port-adapter.ts`) — no
 * module in THIS PR declares `capabilities.consumes` against it (keeping
 * this issue's blast radius atomic, same "extension seam, not yet wired
 * to a real consumer" precedent `organization_structure`'s port had when
 * it first shipped, ADR-0016 §4). A future consumer (including
 * `idn_admin_regions`, see ADR-0021 §4) wires this at ITS OWN composition
 * root (route handler / job script), never inside `domain/` code.
 *
 * Resolution merges the GLOBAL baseline (`awcms_mini_reference_codes`,
 * no RLS — identical for every tenant) with `tenantId`'s own override/
 * extension rows (`awcms_mini_reference_tenant_codes`, RLS FORCE) —
 * `tx` MUST already be tenant-scoped (via `withTenant`) for the tenant
 * half of that merge to read only `tenantId`'s own rows; the baseline
 * half is a plain, unfiltered read of the global tables (same pattern
 * every other reader of a `RLS_FREE_TABLES` entry in this repo uses).
 * See `reference-data/domain/resolution.ts` for the pure precedence
 * logic this adapter applies (tenant override/extension always wins over
 * a same-`code` baseline row, deterministic, as-of aware).
 */
export type ResolvedReferenceCode = {
  code: string;
  /** `true` when this code came from a tenant override/extension row, `false` when it is the unmodified global baseline row. */
  isTenantOverride: boolean;
  label: string;
  description: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  deprecated: boolean;
};

export type ReferenceValueSetSnapshot = {
  key: string;
  name: string;
  status: "active" | "deprecated";
  overridePolicy:
    "none" | "tenant_extend" | "tenant_override" | "tenant_extend_and_override";
  codes: readonly ResolvedReferenceCode[];
};

export type ReferenceDataPort = {
  /**
   * Resolves a single code within `valueSetKey` for `tenantId`, applying
   * baseline/tenant-override precedence and the `asOf`/locale/deprecation
   * rules `domain/resolution.ts` defines. Returns `null` when the value
   * set does not exist, is deprecated, or the code cannot be resolved
   * (unknown/ambiguous codes fail safely — issue #750 requirement) —
   * callers MUST treat `null` as "not usable", never infer a default.
   */
  resolveCode(
    tx: Bun.SQL,
    tenantId: string,
    valueSetKey: string,
    code: string,
    options?: { asOf?: Date; locale?: string; includeDeprecated?: boolean }
  ): Promise<ResolvedReferenceCode | null>;

  /** A safe, bounded snapshot of every currently-resolvable code in a value set for `tenantId` — `null` when the value set does not exist. */
  getSnapshot(
    tx: Bun.SQL,
    tenantId: string,
    valueSetKey: string,
    options?: { asOf?: Date; locale?: string; includeDeprecated?: boolean }
  ): Promise<ReferenceValueSetSnapshot | null>;
};
