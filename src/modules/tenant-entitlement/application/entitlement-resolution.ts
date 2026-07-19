/**
 * Loads a tenant's entitlement records and resolves them into an effective
 * entitlement (Issue #871, epic #868, ADR-0022 §4). BOUNDED: it issues a
 * CONSTANT number of queries independent of the number of feature/quota/module
 * keys resolved (two record reads + one published-offer read per distinct
 * subscribed offer, all bulk) — never a per-key N+1 catalog query (AC / memory
 * `n-plus-1-batch-835-premises`). The heavy lifting is the PURE
 * `resolveEffectiveEntitlement` in `domain/resolution.ts`.
 *
 * The published offers are read through the `service_catalog_read` capability
 * PORT (ADR-0022 §2/§4) — never a direct import of `service_catalog`'s
 * application/domain code (enforced by `tests/unit/module-boundary.test.ts`).
 */
import type { ModuleDescriptor } from "../../_shared/module-contract";
import type { ServiceCatalogReadPort } from "../../_shared/ports/service-catalog-read-port";
import {
  overrideResolutionCap,
  resolveGatedModuleKeys
} from "../domain/entitlement-key-registry";
import {
  offerRefKey,
  resolveEffectiveEntitlement,
  type EffectiveEntitlement,
  type ResolutionAssignment,
  type ResolutionOffer,
  type ResolutionOverride
} from "../domain/resolution";

/** Thrown when a tenant's active override set exceeds the registry-derived cap (indeterminate) — the port adapter catches it and DENIES (fail-closed, Issue #871 review Fix 5). */
export class EntitlementIndeterminateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementIndeterminateError";
  }
}

const MODULE_KEY = "tenant_entitlement";

export { MODULE_KEY as TENANT_ENTITLEMENT_MODULE_KEY };

export type EntitlementResolutionDeps = {
  catalogPort: ServiceCatalogReadPort;
  /** `listModules()` — the module dependency graph for safe-downgrade. */
  moduleDescriptors: readonly ModuleDescriptor[];
};

type AssignmentResolveRow = {
  id: string;
  plan_key: string;
  offer_version: number | string;
  offer_hash: string;
  status: "active" | "suspended" | "canceled";
  effective_from: Date;
  effective_to: Date | null;
  trial_ends_at: Date | null;
  grace_ends_at: Date | null;
  superseded_at: Date | null;
  canceled_at: Date | null;
};

type OverrideResolveRow = {
  id: string;
  target_kind: "feature" | "module" | "quota";
  target_key: string;
  effect: "grant" | "deny";
  quota_is_unlimited: boolean;
  quota_limit_value: number | string | null;
  quota_unit: string | null;
  effective_from: Date;
  effective_to: Date | null;
  revoked_at: Date | null;
};

function toResolutionAssignment(
  row: AssignmentResolveRow
): ResolutionAssignment {
  return {
    id: row.id,
    planKey: row.plan_key,
    offerVersion: Number(row.offer_version),
    offerHash: row.offer_hash,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    trialEndsAt: row.trial_ends_at,
    graceEndsAt: row.grace_ends_at,
    supersededAt: row.superseded_at,
    canceledAt: row.canceled_at
  };
}

function toResolutionOverride(row: OverrideResolveRow): ResolutionOverride {
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetKey: row.target_key,
    effect: row.effect,
    quotaIsUnlimited: row.quota_is_unlimited,
    quotaLimitValue:
      row.quota_limit_value === null ? null : Number(row.quota_limit_value),
    quotaUnit: row.quota_unit,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    revokedAt: row.revoked_at
  };
}

function buildModuleDependencyMap(
  descriptors: readonly ModuleDescriptor[]
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const descriptor of descriptors) {
    map.set(descriptor.key, descriptor.dependencies ?? []);
  }
  return map;
}

/**
 * Resolve a tenant's effective entitlement AT `now`. Caller must already be
 * authorized (the operator route's ABAC guard, or the port adapter's
 * module-enabled + fail-closed wrapper). Bounded query count.
 */
export async function resolveTenantEntitlement(
  tx: Bun.SQL,
  tenantId: string,
  deps: EntitlementResolutionDeps,
  now: Date
): Promise<EffectiveEntitlement> {
  // 1. Current (non-superseded, non-canceled) assignments — the only ones that
  //    can contribute grants. Bounded by the tenant's subscribed plan count.
  const assignmentRows = (await tx`
    SELECT id, plan_key, offer_version, offer_hash, currency, status,
      effective_from, effective_to, trial_ends_at, grace_ends_at,
      superseded_at, canceled_at
    FROM awcms_mini_tenant_entitlement_assignments
    WHERE tenant_id = ${tenantId}
      AND superseded_at IS NULL
      AND status <> 'canceled'
    ORDER BY plan_key ASC, offer_version DESC
    LIMIT 500
  `) as AssignmentResolveRow[];

  // 2. Non-revoked overrides — the resolver checks each one's effective window.
  //    A truncated override set could silently DROP a DENY and fail OPEN
  //    (asymmetric with the assignment cap, where dropping a GRANT fails safe).
  //    Active overrides are hard-bounded by the registry cardinality (one per
  //    distinct kind+key, partial unique index), so we size the query to that
  //    cap + 1 and FAIL CLOSED if the set somehow exceeds it (indeterminate ->
  //    the port adapter denies). Issue #871 review Fix 5.
  const overrideCap = overrideResolutionCap(deps.moduleDescriptors);
  const overrideRows = (await tx`
    SELECT id, target_kind, target_key, effect, quota_is_unlimited,
      quota_limit_value, quota_unit, effective_from, effective_to, revoked_at
    FROM awcms_mini_tenant_entitlement_overrides
    WHERE tenant_id = ${tenantId} AND revoked_at IS NULL
    ORDER BY target_kind ASC, target_key ASC
    LIMIT ${overrideCap + 1}
  `) as OverrideResolveRow[];
  if (overrideRows.length > overrideCap) {
    throw new EntitlementIndeterminateError(
      `tenant_entitlement: active override set (> ${overrideCap}) exceeds the registry cap — resolution is indeterminate and denied (fail-closed).`
    );
  }

  const assignments = assignmentRows.map(toResolutionAssignment);
  const overrides = overrideRows.map(toResolutionOverride);

  // 3. Published offers for the DISTINCT (planKey, version) pairs the
  //    assignments reference — ONE catalog read per distinct offer (bounded by
  //    subscription count, NOT by the number of keys resolved). Never a per-key
  //    query. Reads through the read-only capability port (published-only).
  const offers = new Map<string, ResolutionOffer>();
  const seen = new Set<string>();
  for (const assignment of assignments) {
    const key = offerRefKey(assignment.planKey, assignment.offerVersion);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const offer = await deps.catalogPort.getPublishedOffer(
      assignment.planKey,
      assignment.offerVersion
    );
    if (offer) {
      offers.set(key, {
        planKey: offer.planKey,
        version: offer.version,
        offerHash: offer.offerHash,
        features: offer.features.map((f) => ({
          featureKind: f.featureKind,
          featureKey: f.featureKey,
          enabled: f.enabled
        })),
        quotas: offer.quotas.map((q) => ({
          meterKey: q.meterKey,
          isUnlimited: q.isUnlimited,
          limitValue: q.limitValue,
          unit: q.unit
        }))
      });
    }
  }

  return resolveEffectiveEntitlement({
    tenantId,
    now,
    assignments,
    overrides,
    offers,
    moduleDependencies: buildModuleDependencyMap(deps.moduleDescriptors),
    gatedModuleKeys: resolveGatedModuleKeys(deps.moduleDescriptors)
  });
}
