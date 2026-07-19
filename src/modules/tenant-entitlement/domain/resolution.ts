/**
 * Effective-entitlement RESOLUTION (Issue #871, epic #868 SaaS control plane,
 * ADR-0022 §4). PURE — no I/O. Given a tenant's assignments, overrides, the
 * published offers those assignments point at, and the module dependency graph,
 * it computes a DETERMINISTIC, EXPLAINABLE effective entitlement for a
 * timestamp, and the fail-closed lookup helpers that gate commercial access.
 *
 * FAIL-CLOSED INVARIANT (ADR-0022 §4 High-2 — the security core). This is the
 * ONE place the gating decision lives (a helper, never per-route — memory
 * `ssr-admin-pages-skip-module-enabled`). Any key that is unknown, absent,
 * indeterminate, unavailable, or resolved from a disabled tenant_entitlement is
 * DENIED — never grant-all. `isFeatureAllowed`/`isModuleEntitled`/`getQuota`
 * return deny for anything not strictly, positively granted.
 *
 * ENTITLEMENT != PERMISSION (ADR-0022 §4). This answers "is this tenant
 * subscribed to feature/quota X" on a DIFFERENT axis from ABAC's "may this
 * actor do action Y". A positive entitlement here NEVER grants an authorization
 * — RBAC/ABAC/RLS remain authoritative and are checked independently.
 *
 * PRECEDENCE (deterministic, deny-overrides): for each key, an ACTIVE operator
 * override REPLACES the offer decision (the DB enforces AT MOST ONE active
 * override per key, so grant/deny is unambiguous — a deny simply denies). With
 * no override, the offer grant from an active assignment holds. With neither,
 * the key is absent -> the lookup helpers deny.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inputs (plain shapes; the application layer maps DB rows / the
// `service_catalog_read` port's PublishedOffer into these)
// ---------------------------------------------------------------------------

export type ResolutionAssignment = {
  id: string;
  planKey: string;
  offerVersion: number;
  offerHash: string;
  status: "active" | "suspended" | "canceled";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  supersededAt: Date | null;
  canceledAt: Date | null;
};

export type ResolutionOfferFeature = {
  featureKind: "feature" | "module";
  featureKey: string;
  enabled: boolean;
};

export type ResolutionOfferQuota = {
  meterKey: string;
  isUnlimited: boolean;
  limitValue: number | null;
  unit: string;
};

export type ResolutionOffer = {
  planKey: string;
  version: number;
  offerHash: string;
  features: ResolutionOfferFeature[];
  quotas: ResolutionOfferQuota[];
};

export type ResolutionOverride = {
  id: string;
  targetKind: "feature" | "module" | "quota";
  targetKey: string;
  effect: "grant" | "deny";
  quotaIsUnlimited: boolean;
  quotaLimitValue: number | null;
  quotaUnit: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  revokedAt: Date | null;
};

export type ResolutionInput = {
  tenantId: string;
  now: Date;
  assignments: readonly ResolutionAssignment[];
  overrides: readonly ResolutionOverride[];
  /** All published offers, keyed by `offerRefKey(planKey, version)` — fetched in ONE bulk read (no per-request N+1, AC / memory `n-plus-1-batch-835-premises`). */
  offers: ReadonlyMap<string, ResolutionOffer>;
  /** `moduleKey -> its declared dependencies` (from `listModules()`), for safe-downgrade. */
  moduleDependencies: ReadonlyMap<string, readonly string[]>;
  /**
   * The set of module keys that are COMMERCIALLY GATED (offerable — a tenant
   * must be ENTITLED to use them), i.e. every non-base/non-foundational module
   * (see `resolveGatedModuleKeys`). Used by safe-downgrade to distinguish a
   * dependency that is an always-available BASE module (absent from the entitled
   * set = still satisfied) from a gated one (absent = NOT entitled = DENY,
   * fail-closed — ADR-0022 §4). Without this, a granted module whose gated
   * dependency was never subscribed would stay entitled (over-grant).
   */
  gatedModuleKeys: ReadonlySet<string>;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Substate of a contributing assignment (why its grants apply). */
export type AssignmentSubstate = "active" | "trial" | "grace";

export type EntitlementSource =
  | {
      kind: "offer";
      assignmentId: string;
      planKey: string;
      version: number;
      offerHash: string;
      substate: AssignmentSubstate;
    }
  | {
      kind: "override";
      overrideId: string;
      effect: "grant" | "deny";
      effectiveTo: string | null;
    }
  | { kind: "dependency_not_entitled"; dependencyKey: string }
  | { kind: "default_deny" };

export type FeatureDecision = { allowed: boolean; source: EntitlementSource };
export type ModuleDecision = { allowed: boolean; source: EntitlementSource };
export type QuotaDecision = {
  allowed: boolean;
  isUnlimited: boolean;
  /** Remaining/allowed limit units. `null` iff unlimited; `0` for a denied/absent quota (no allowance). */
  limit: number | null;
  unit: string | null;
  source: EntitlementSource;
};

export type AssignmentExplanation = {
  assignmentId: string;
  planKey: string;
  version: number;
  offerHash: string;
  substate: AssignmentSubstate;
};

export type EffectiveEntitlement = {
  tenantId: string;
  resolvedAt: string;
  /** `disabled` = tenant_entitlement is not enabled for this tenant -> ALL lookups deny (fail-closed, ADR-0022 §4). */
  status: "resolved" | "disabled";
  features: Record<string, FeatureDecision>;
  modules: Record<string, ModuleDecision>;
  quotas: Record<string, QuotaDecision>;
  assignments: AssignmentExplanation[];
  /** sha256 over the TENANT-FACING resolved decisions ONLY (no operator reasons, no timestamp) — reproducible + the deterministic cache-invalidation key (epic pattern #5). */
  snapshotHash: string;
};

export const DENIED_QUOTA: QuotaDecision = {
  allowed: false,
  isUnlimited: false,
  limit: 0,
  unit: null,
  source: { kind: "default_deny" }
};

/** Stable key for `ResolutionInput.offers` and offer lookups. */
export function offerRefKey(planKey: string, version: number): string {
  return `${planKey}@${version}`;
}

/**
 * The substate an assignment contributes AT `now`, or `null` if it contributes
 * NOTHING (canceled, superseded, suspended, or outside its effective window).
 * A suspended assignment withholds grants (the "suspension/lifecycle
 * restriction" resolution input) — data is untouched, only access is gated.
 */
export function assignmentSubstate(
  assignment: ResolutionAssignment,
  now: Date
): AssignmentSubstate | null {
  if (
    assignment.status !== "active" ||
    assignment.canceledAt !== null ||
    assignment.supersededAt !== null
  ) {
    return null;
  }
  const t = now.getTime();
  if (t < assignment.effectiveFrom.getTime()) {
    return null;
  }
  if (
    assignment.effectiveTo !== null &&
    t >= assignment.effectiveTo.getTime()
  ) {
    return null;
  }
  if (assignment.trialEndsAt !== null && t < assignment.trialEndsAt.getTime()) {
    return "trial";
  }
  if (assignment.graceEndsAt !== null && t < assignment.graceEndsAt.getTime()) {
    return "grace";
  }
  return "active";
}

function overrideActive(override: ResolutionOverride, now: Date): boolean {
  if (override.revokedAt !== null) {
    return false;
  }
  const t = now.getTime();
  if (t < override.effectiveFrom.getTime()) {
    return false;
  }
  if (override.effectiveTo !== null && t >= override.effectiveTo.getTime()) {
    return false;
  }
  return true;
}

/** Deterministic assignment ordering so first-wins grant attribution is stable. */
function compareAssignments(
  a: ResolutionAssignment,
  b: ResolutionAssignment
): number {
  if (a.planKey !== b.planKey) return a.planKey < b.planKey ? -1 : 1;
  if (a.offerVersion !== b.offerVersion) return b.offerVersion - a.offerVersion;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** More-generous quota wins (unlimited beats any finite; else higher limit). */
function mergeQuota(
  current: QuotaDecision | undefined,
  incoming: QuotaDecision
): QuotaDecision {
  if (!current) return incoming;
  if (incoming.isUnlimited) return incoming;
  if (current.isUnlimited) return current;
  return (incoming.limit ?? 0) > (current.limit ?? 0) ? incoming : current;
}

export function resolveEffectiveEntitlement(
  input: ResolutionInput
): EffectiveEntitlement {
  const features: Record<string, FeatureDecision> = {};
  const modules: Record<string, ModuleDecision> = {};
  const quotas: Record<string, QuotaDecision> = {};
  const explanations: AssignmentExplanation[] = [];

  // 1. Base grants from CONTRIBUTING assignments' offers.
  const sortedAssignments = [...input.assignments].sort(compareAssignments);
  for (const assignment of sortedAssignments) {
    const substate = assignmentSubstate(assignment, input.now);
    if (substate === null) {
      continue;
    }
    const offer = input.offers.get(
      offerRefKey(assignment.planKey, assignment.offerVersion)
    );
    if (!offer) {
      // Offer unavailable (e.g. purged) -> fail-closed: contributes no grants.
      continue;
    }
    explanations.push({
      assignmentId: assignment.id,
      planKey: assignment.planKey,
      version: assignment.offerVersion,
      offerHash: assignment.offerHash,
      substate
    });
    const source: EntitlementSource = {
      kind: "offer",
      assignmentId: assignment.id,
      planKey: assignment.planKey,
      version: assignment.offerVersion,
      offerHash: assignment.offerHash,
      substate
    };
    for (const feature of offer.features) {
      if (!feature.enabled) {
        continue; // an explicitly-disabled feature in an offer is not a grant.
      }
      const target = feature.featureKind === "module" ? modules : features;
      const existing = target[feature.featureKey];
      if (!existing || !existing.allowed) {
        target[feature.featureKey] = { allowed: true, source };
      }
    }
    for (const quota of offer.quotas) {
      quotas[quota.meterKey] = mergeQuota(quotas[quota.meterKey], {
        allowed: true,
        isUnlimited: quota.isUnlimited,
        limit: quota.isUnlimited ? null : quota.limitValue,
        unit: quota.unit,
        source
      });
    }
  }

  // 2. Overrides REPLACE the offer decision for their key (deny-overrides is
  //    implicit: the DB guarantees at most one ACTIVE override per key, so a
  //    deny simply denies, a grant grants).
  for (const override of input.overrides) {
    if (!overrideActive(override, input.now)) {
      continue;
    }
    const source: EntitlementSource = {
      kind: "override",
      overrideId: override.id,
      effect: override.effect,
      effectiveTo: override.effectiveTo?.toISOString() ?? null
    };
    if (override.targetKind === "quota") {
      quotas[override.targetKey] =
        override.effect === "grant"
          ? {
              allowed: true,
              isUnlimited: override.quotaIsUnlimited,
              limit: override.quotaIsUnlimited
                ? null
                : override.quotaLimitValue,
              unit: override.quotaUnit,
              source
            }
          : {
              allowed: false,
              isUnlimited: false,
              limit: 0,
              unit: null,
              source
            };
    } else {
      const target = override.targetKind === "module" ? modules : features;
      target[override.targetKey] = {
        allowed: override.effect === "grant",
        source
      };
    }
  }

  // 3. Module dependency SAFE-DOWNGRADE (fixpoint; monotonic false-propagation,
  //    bounded by module count). A granted module stays entitled only if every
  //    declared dependency is SATISFIED. A dependency is satisfied iff it is a
  //    BASE/always-available module (NOT in `gatedModuleKeys`) OR it is a GATED
  //    module that resolved entitled. A GATED dependency that is absent from the
  //    entitled set is treated as NOT entitled (fail-closed, ADR-0022 §4) — this
  //    is what distinguishes "the platform always provides tenant_admin" from
  //    "the tenant never subscribed to blog_content"; the old `depDecision &&`
  //    guard silently treated the latter as satisfied (over-grant). Downgrade
  //    only (never an upgrade / data deletion).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [moduleKey, decision] of Object.entries(modules)) {
      if (!decision.allowed) {
        continue;
      }
      const deps = input.moduleDependencies.get(moduleKey) ?? [];
      for (const dep of deps) {
        const depSatisfied =
          !input.gatedModuleKeys.has(dep) || modules[dep]?.allowed === true;
        if (!depSatisfied) {
          modules[moduleKey] = {
            allowed: false,
            source: { kind: "dependency_not_entitled", dependencyKey: dep }
          };
          changed = true;
          break;
        }
      }
    }
  }

  const resolved: Omit<EffectiveEntitlement, "snapshotHash"> = {
    tenantId: input.tenantId,
    resolvedAt: input.now.toISOString(),
    status: "resolved",
    features,
    modules,
    quotas,
    assignments: explanations
  };
  return { ...resolved, snapshotHash: computeSnapshotHash(resolved) };
}

/** A resolution for a tenant whose `tenant_entitlement` is disabled: ALL lookups deny (fail-closed, ADR-0022 §4). */
export function disabledEntitlement(
  tenantId: string,
  now: Date
): EffectiveEntitlement {
  const resolved: Omit<EffectiveEntitlement, "snapshotHash"> = {
    tenantId,
    resolvedAt: now.toISOString(),
    status: "disabled",
    features: {},
    modules: {},
    quotas: {},
    assignments: []
  };
  return { ...resolved, snapshotHash: computeSnapshotHash(resolved) };
}

/**
 * The EXACT projection the snapshot hash covers — and it must be EXACTLY the
 * shape the `effective_entitlement` PORT exposes to consumers
 * (`EffectiveEntitlementSnapshot`: feature/module = `key -> allowed`; quota =
 * `key -> { allowed, isUnlimited, limit, unit }`). Epic pattern #5 / #870
 * lesson: "hash exactly what is exposed" — so it can never become an ORACLE
 * over operator-only data NOR miss a tenant-visible change:
 *   - `source.kind` is NOT hashed (the port strips `source`; hashing it would
 *     let a redundant offer->override provenance flip change the hash while the
 *     tenant-visible booleans are identical);
 *   - quota `unit` IS hashed (the port exposes it; two resolutions differing
 *     only in unit must produce different hashes so a derived cache
 *     invalidates — consumed by #875/#876).
 * `resolvedAt`/`status` are excluded from the per-key projection so identical
 * decisions at different times hash the same (correct cache-invalidation).
 * `SNAPSHOT_HASH_QUOTA_FIELDS` is asserted against the port type by a gate test.
 */
export const SNAPSHOT_HASH_DECISION_FIELDS = ["key", "allowed"] as const;
export const SNAPSHOT_HASH_QUOTA_FIELDS = [
  "key",
  "allowed",
  "isUnlimited",
  "limit",
  "unit"
] as const;

/** Build the canonical, port-shaped projection the hash is computed over (exported for the gate test). */
export function snapshotHashProjection(
  resolution: Pick<
    EffectiveEntitlement,
    "status" | "features" | "modules" | "quotas"
  >
): {
  status: string;
  features: { key: string; allowed: boolean }[];
  modules: { key: string; allowed: boolean }[];
  quotas: {
    key: string;
    allowed: boolean;
    isUnlimited: boolean;
    limit: number | null;
    unit: string | null;
  }[];
} {
  return {
    status: resolution.status,
    features: projectDecisions(resolution.features),
    modules: projectDecisions(resolution.modules),
    quotas: Object.keys(resolution.quotas)
      .sort()
      .map((key) => {
        const q = resolution.quotas[key]!;
        return {
          key,
          allowed: q.allowed,
          isUnlimited: q.isUnlimited,
          limit: q.limit,
          unit: q.unit
        };
      })
  };
}

export function computeSnapshotHash(
  resolution: Pick<
    EffectiveEntitlement,
    "status" | "features" | "modules" | "quotas"
  >
): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshotHashProjection(resolution)))
    .digest("hex");
}

function projectDecisions(
  map: Record<string, FeatureDecision | ModuleDecision>
): { key: string; allowed: boolean }[] {
  return Object.keys(map)
    .sort()
    .map((key) => ({ key, allowed: map[key]!.allowed }));
}

// ---------------------------------------------------------------------------
// FAIL-CLOSED lookup helpers — the single gating surface (ADR-0022 §4 High-2)
// ---------------------------------------------------------------------------

/** Fail-closed: `true` ONLY for a resolved entitlement whose feature key is strictly, positively granted. */
export function isFeatureAllowed(
  entitlement: EffectiveEntitlement,
  featureKey: string
): boolean {
  return (
    entitlement.status === "resolved" &&
    entitlement.features[featureKey]?.allowed === true
  );
}

/** Fail-closed: `true` ONLY for a resolved entitlement whose module key is strictly, positively entitled. */
export function isModuleEntitled(
  entitlement: EffectiveEntitlement,
  moduleKey: string
): boolean {
  return (
    entitlement.status === "resolved" &&
    entitlement.modules[moduleKey]?.allowed === true
  );
}

/** Fail-closed: an unknown/absent/disabled quota returns `DENIED_QUOTA` (no allowance). */
export function getQuota(
  entitlement: EffectiveEntitlement,
  meterKey: string
): QuotaDecision {
  if (entitlement.status !== "resolved") {
    return DENIED_QUOTA;
  }
  return entitlement.quotas[meterKey] ?? DENIED_QUOTA;
}
