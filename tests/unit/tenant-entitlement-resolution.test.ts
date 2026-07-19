/**
 * Pure unit tests for `tenant_entitlement` (Issue #871, epic #868, ADR-0022).
 * No DB. Covers the fail-closed resolution core (precedence, effective dates,
 * overrides, suspension, unknown-key DENY, explanation, dependency downgrade,
 * snapshot hash), the validators, and the fail-closed request parsing.
 *
 * MUTATION-GUARD (AC): "changing unknown-key behavior to allow must fail" — the
 * `unknown key -> DENY` tests below are that guard. Flipping any fail-closed
 * lookup default from `=== true` to a truthy/allow default breaks them.
 */
import { describe, expect, test } from "bun:test";

import {
  assignmentSubstate,
  computeSnapshotHash,
  disabledEntitlement,
  getQuota,
  isFeatureAllowed,
  isModuleEntitled,
  offerRefKey,
  resolveEffectiveEntitlement,
  snapshotHashProjection,
  SNAPSHOT_HASH_DECISION_FIELDS,
  SNAPSHOT_HASH_QUOTA_FIELDS,
  type ResolutionAssignment,
  type ResolutionInput,
  type ResolutionOffer,
  type ResolutionOverride
} from "../../src/modules/tenant-entitlement/domain/resolution";
import {
  isLegalTransition,
  requiredActionForTransition,
  validateAssignInput,
  validateOverrideInput,
  type AssignInput,
  type OverrideInput
} from "../../src/modules/tenant-entitlement/domain/entitlement";
import {
  isEntitlementGatedModule,
  isKnownEntitlementTarget,
  overrideResolutionCap,
  resolveEntitlementKeyRegistry,
  resolveGatedModuleKeys
} from "../../src/modules/tenant-entitlement/domain/entitlement-key-registry";
import { resolveServiceCatalogKeyRegistry } from "../../src/modules/service-catalog/domain/key-registry";
import { listModules } from "../../src/modules";
import {
  parseAssignBody,
  parseOverrideBody,
  parseTransitionBody
} from "../../src/modules/tenant-entitlement/application/request-parsing";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const PLAN = "growth";

function offer(over: Partial<ResolutionOffer> = {}): ResolutionOffer {
  return {
    planKey: PLAN,
    version: 1,
    offerHash: "hash-1",
    features: [
      {
        featureKind: "feature",
        featureKey: "platform.api_access",
        enabled: true
      },
      { featureKind: "module", featureKey: "blog_content", enabled: true },
      {
        featureKind: "feature",
        featureKey: "platform.disabled_feat",
        enabled: false
      }
    ],
    quotas: [
      {
        meterKey: "platform.api_calls",
        isUnlimited: false,
        limitValue: 1000,
        unit: "requests"
      }
    ],
    ...over
  };
}

function assignment(
  over: Partial<ResolutionAssignment> = {}
): ResolutionAssignment {
  return {
    id: "a1",
    planKey: PLAN,
    offerVersion: 1,
    offerHash: "hash-1",
    status: "active",
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    trialEndsAt: null,
    graceEndsAt: null,
    supersededAt: null,
    canceledAt: null,
    ...over
  };
}

function input(over: Partial<ResolutionInput> = {}): ResolutionInput {
  const o = offer();
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    now: NOW,
    assignments: [assignment()],
    overrides: [],
    offers: new Map([[offerRefKey(o.planKey, o.version), o]]),
    moduleDependencies: new Map(),
    gatedModuleKeys: new Set(),
    ...over
  };
}

function override(over: Partial<ResolutionOverride> = {}): ResolutionOverride {
  return {
    id: "o1",
    targetKind: "feature",
    targetKey: "platform.api_access",
    effect: "deny",
    quotaIsUnlimited: false,
    quotaLimitValue: null,
    quotaUnit: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    revokedAt: null,
    ...over
  };
}

describe("resolveEffectiveEntitlement — base offer grants", () => {
  test("grants enabled offer features/modules/quotas; excludes disabled features", () => {
    const ee = resolveEffectiveEntitlement(input());
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(true);
    expect(isModuleEntitled(ee, "blog_content")).toBe(true);
    expect(ee.features["platform.disabled_feat"]).toBeUndefined();
    const quota = getQuota(ee, "platform.api_calls");
    expect(quota.allowed).toBe(true);
    expect(quota.limit).toBe(1000);
    expect(quota.unit).toBe("requests");
    // Explanation carries a source.
    expect(ee.features["platform.api_access"]!.source.kind).toBe("offer");
    expect(ee.assignments).toHaveLength(1);
    expect(ee.assignments[0]!.substate).toBe("active");
  });
});

describe("resolveEffectiveEntitlement — FAIL-CLOSED unknown key (MUTATION-GUARD)", () => {
  test("an unknown feature/module key is DENIED", () => {
    const ee = resolveEffectiveEntitlement(input());
    expect(isFeatureAllowed(ee, "totally.unknown")).toBe(false);
    expect(isModuleEntitled(ee, "unknown_module")).toBe(false);
  });

  test("an unknown quota returns a denied allowance (no units)", () => {
    const ee = resolveEffectiveEntitlement(input());
    const q = getQuota(ee, "totally.unknown");
    expect(q.allowed).toBe(false);
    expect(q.limit).toBe(0);
    expect(q.isUnlimited).toBe(false);
  });

  test("a tenant with NO assignments/overrides denies everything", () => {
    const ee = resolveEffectiveEntitlement(
      input({ assignments: [], offers: new Map() })
    );
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
    expect(isModuleEntitled(ee, "blog_content")).toBe(false);
    expect(getQuota(ee, "platform.api_calls").allowed).toBe(false);
  });

  test("a DISABLED entitlement denies everything (fail-closed)", () => {
    const ee = disabledEntitlement("11111111-1111-1111-1111-111111111111", NOW);
    expect(ee.status).toBe("disabled");
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
    expect(isModuleEntitled(ee, "blog_content")).toBe(false);
    expect(getQuota(ee, "platform.api_calls").allowed).toBe(false);
  });
});

describe("resolveEffectiveEntitlement — override precedence (deny-overrides)", () => {
  test("an active DENY override beats the offer grant", () => {
    const ee = resolveEffectiveEntitlement(
      input({ overrides: [override({ effect: "deny" })] })
    );
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
    expect(ee.features["platform.api_access"]!.source.kind).toBe("override");
  });

  test("a GRANT override adds a feature the offer does not grant", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({ targetKey: "platform.custom_domain", effect: "grant" })
        ]
      })
    );
    expect(isFeatureAllowed(ee, "platform.custom_domain")).toBe(true);
  });

  test("a quota GRANT override replaces the offer quota", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({
            targetKind: "quota",
            targetKey: "platform.api_calls",
            effect: "grant",
            quotaIsUnlimited: true
          })
        ]
      })
    );
    const q = getQuota(ee, "platform.api_calls");
    expect(q.allowed).toBe(true);
    expect(q.isUnlimited).toBe(true);
    expect(q.limit).toBeNull();
    expect(q.source.kind).toBe("override");
  });

  test("a quota DENY override denies the meter", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({
            targetKind: "quota",
            targetKey: "platform.api_calls",
            effect: "deny"
          })
        ]
      })
    );
    expect(getQuota(ee, "platform.api_calls").allowed).toBe(false);
  });
});

describe("resolveEffectiveEntitlement — effective dates (no restart needed)", () => {
  test("an EXPIRED override (effectiveTo in the past) no longer applies", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({
            effect: "deny",
            effectiveTo: new Date("2026-07-19T11:59:59.000Z")
          })
        ]
      })
    );
    // The deny expired one second ago -> the offer grant is back.
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(true);
  });

  test("a FUTURE override (effectiveFrom later) does not apply yet", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({
            targetKey: "platform.custom_domain",
            effect: "grant",
            effectiveFrom: new Date("2026-08-01T00:00:00.000Z")
          })
        ]
      })
    );
    expect(isFeatureAllowed(ee, "platform.custom_domain")).toBe(false);
  });

  test("a REVOKED override does not apply", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({
            effect: "deny",
            revokedAt: new Date("2026-07-10T00:00:00.000Z")
          })
        ]
      })
    );
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(true);
  });

  test("an assignment past its effectiveTo contributes nothing", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        assignments: [
          assignment({ effectiveTo: new Date("2026-07-19T11:00:00.000Z") })
        ]
      })
    );
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
  });
});

describe("assignmentSubstate — suspension + trial/grace", () => {
  test("a suspended assignment contributes nothing", () => {
    expect(
      assignmentSubstate(assignment({ status: "suspended" }), NOW)
    ).toBeNull();
    const ee = resolveEffectiveEntitlement(
      input({ assignments: [assignment({ status: "suspended" })] })
    );
    expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
  });

  test("a canceled assignment contributes nothing", () => {
    expect(
      assignmentSubstate(
        assignment({ status: "canceled", canceledAt: NOW }),
        NOW
      )
    ).toBeNull();
  });

  test("a superseded assignment contributes nothing", () => {
    expect(
      assignmentSubstate(assignment({ supersededAt: NOW }), NOW)
    ).toBeNull();
  });

  test("trial window -> substate trial; grace window -> substate grace", () => {
    expect(
      assignmentSubstate(
        assignment({ trialEndsAt: new Date("2026-08-01T00:00:00.000Z") }),
        NOW
      )
    ).toBe("trial");
    expect(
      assignmentSubstate(
        assignment({ graceEndsAt: new Date("2026-08-01T00:00:00.000Z") }),
        NOW
      )
    ).toBe("grace");
  });
});

describe("resolveEffectiveEntitlement — module dependency safe-downgrade", () => {
  test("an entitled module whose entitlement-relevant dependency is denied is downgraded", () => {
    const modOffer: ResolutionOffer = {
      planKey: PLAN,
      version: 1,
      offerHash: "h",
      features: [
        { featureKind: "module", featureKey: "mod_a", enabled: true },
        { featureKind: "module", featureKey: "mod_b", enabled: true }
      ],
      quotas: []
    };
    const ee = resolveEffectiveEntitlement(
      input({
        assignments: [assignment()],
        offers: new Map([[offerRefKey(PLAN, 1), modOffer]]),
        // deny mod_b via override; mod_a depends on mod_b (both gated).
        overrides: [
          override({ targetKind: "module", targetKey: "mod_b", effect: "deny" })
        ],
        moduleDependencies: new Map([["mod_a", ["mod_b"]]]),
        gatedModuleKeys: new Set(["mod_a", "mod_b"])
      })
    );
    expect(isModuleEntitled(ee, "mod_b")).toBe(false);
    expect(isModuleEntitled(ee, "mod_a")).toBe(false);
    expect(ee.modules["mod_a"]!.source.kind).toBe("dependency_not_entitled");
  });

  test("Fix 2: a GATED dependency ABSENT from the entitled set fails closed (downgrade)", () => {
    // social_publishing granted (via override); its dependency blog_content is
    // GATED but the tenant never subscribed to it (absent from the resolved
    // set). Fail-closed: absent gated dep = NOT entitled -> downgrade.
    const ee = resolveEffectiveEntitlement(
      input({
        assignments: [],
        offers: new Map(),
        overrides: [
          override({
            targetKind: "module",
            targetKey: "social_publishing",
            effect: "grant"
          })
        ],
        moduleDependencies: new Map([["social_publishing", ["blog_content"]]]),
        gatedModuleKeys: new Set(["social_publishing", "blog_content"])
      })
    );
    expect(isModuleEntitled(ee, "social_publishing")).toBe(false);
    expect(ee.modules["social_publishing"]!.source.kind).toBe(
      "dependency_not_entitled"
    );
  });

  test("Fix 2: a BASE (non-gated) dependency ABSENT stays satisfied (no downgrade)", () => {
    // blog_content granted; its dependency tenant_admin is a base always-on
    // module (NOT in the gated set) -> absence is satisfied, blog_content stays.
    const ee = resolveEffectiveEntitlement(
      input({
        moduleDependencies: new Map([["blog_content", ["tenant_admin"]]]),
        gatedModuleKeys: new Set(["blog_content"]) // tenant_admin deliberately NOT gated
      })
    );
    expect(isModuleEntitled(ee, "blog_content")).toBe(true);
  });
});

describe("computeSnapshotHash — reproducible, timestamp-independent, no oracle", () => {
  test("identical decisions at different times produce the SAME hash", () => {
    const a = resolveEffectiveEntitlement(input({ now: NOW }));
    const b = resolveEffectiveEntitlement(
      input({ now: new Date("2026-07-19T18:00:00.000Z") })
    );
    expect(a.snapshotHash).toBe(b.snapshotHash);
  });

  test("different decisions produce a DIFFERENT hash", () => {
    const a = resolveEffectiveEntitlement(input());
    const b = resolveEffectiveEntitlement(
      input({ overrides: [override({ effect: "deny" })] })
    );
    expect(a.snapshotHash).not.toBe(b.snapshotHash);
  });

  test("computeSnapshotHash excludes resolvedAt", () => {
    const ee = resolveEffectiveEntitlement(input());
    expect(computeSnapshotHash(ee)).toBe(ee.snapshotHash);
  });

  test("Fix 4: a redundant GRANT override does NOT change the hash (source is not exposed by the port)", () => {
    // Offer already grants platform.api_access (source: offer). Adding a
    // grant-override for the SAME key keeps the tenant-visible boolean = true;
    // only the provenance flips offer -> override. The hash must NOT change (the
    // port strips `source`; hashing it would be an oracle over operator-only
    // provenance).
    const base = resolveEffectiveEntitlement(input());
    const withRedundantOverride = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({ targetKey: "platform.api_access", effect: "grant" })
        ]
      })
    );
    expect(isFeatureAllowed(base, "platform.api_access")).toBe(true);
    expect(isFeatureAllowed(withRedundantOverride, "platform.api_access")).toBe(
      true
    );
    expect(withRedundantOverride.snapshotHash).toBe(base.snapshotHash);
  });

  test("Fix 4: a quota UNIT change DOES change the hash (unit is exposed by the port)", () => {
    const base = resolveEffectiveEntitlement(input());
    const differentUnit = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({
            targetKind: "quota",
            targetKey: "platform.api_calls",
            effect: "grant",
            quotaLimitValue: 1000,
            quotaUnit: "calls" // offer uses "requests" with the same limit 1000
          })
        ]
      })
    );
    expect(getQuota(base, "platform.api_calls").unit).toBe("requests");
    expect(getQuota(differentUnit, "platform.api_calls").unit).toBe("calls");
    expect(differentUnit.snapshotHash).not.toBe(base.snapshotHash);
  });

  test("Fix 4 GATE: the hash projection covers EXACTLY the fields the port snapshot exposes", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        overrides: [
          override({
            targetKind: "quota",
            targetKey: "platform.api_calls",
            effect: "grant",
            quotaLimitValue: 5,
            quotaUnit: "requests"
          })
        ]
      })
    );
    const projection = snapshotHashProjection(ee);
    // Feature/module entries: exactly {key, allowed} — never source/sourceKind.
    for (const entry of [...projection.features, ...projection.modules]) {
      expect(Object.keys(entry).sort()).toEqual(["allowed", "key"]);
    }
    // Quota entries: exactly {key} + the port's QuotaAllowance fields.
    const portSnapshot = toPortSnapshotShape(ee);
    for (const entry of projection.quotas) {
      expect(Object.keys(entry).sort()).toEqual(
        ["key", ...Object.keys(portSnapshot.quotaAllowanceSample)].sort()
      );
    }
    // The declared field constants match the projection.
    expect([...SNAPSHOT_HASH_DECISION_FIELDS] as string[]).toEqual([
      "key",
      "allowed"
    ]);
    expect(([...SNAPSHOT_HASH_QUOTA_FIELDS] as string[]).sort()).toEqual(
      ["key", ...Object.keys(portSnapshot.quotaAllowanceSample)].sort()
    );
  });
});

/** A QuotaAllowance-shaped sample so the gate above compares hash quota fields against the exact PORT-exposed shape. */
function toPortSnapshotShape(ee: {
  quotas: Record<
    string,
    {
      allowed: boolean;
      isUnlimited: boolean;
      limit: number | null;
      unit: string | null;
    }
  >;
}): { quotaAllowanceSample: Record<string, unknown> } {
  const firstKey = Object.keys(ee.quotas)[0]!;
  const q = ee.quotas[firstKey]!;
  // Exactly the QuotaAllowance shape the port exposes (effective-entitlement-port.ts).
  const allowance = {
    allowed: q.allowed,
    isUnlimited: q.isUnlimited,
    limit: q.limit,
    unit: q.unit
  };
  return { quotaAllowanceSample: allowance };
}

describe("entitlement key registry — fail-closed unknown", () => {
  const registry = resolveEntitlementKeyRegistry([
    {
      key: "demo_module",
      name: "Demo",
      version: "1.0.0",
      status: "active",
      description: "",
      dependencies: [],
      serviceCatalog: {
        contributesFeatureKeys: ["demo.feature_x"],
        contributesMeterKeys: ["demo.meter_y"]
      }
    } as ModuleDescriptor
  ]);

  test("known feature/module/meter keys resolve; unknown fail closed", () => {
    expect(
      isKnownEntitlementTarget(registry, "feature", "demo.feature_x")
    ).toBe(true);
    expect(isKnownEntitlementTarget(registry, "module", "demo_module")).toBe(
      true
    );
    expect(isKnownEntitlementTarget(registry, "quota", "demo.meter_y")).toBe(
      true
    );
    expect(isKnownEntitlementTarget(registry, "feature", "demo.meter_y")).toBe(
      false
    );
    expect(isKnownEntitlementTarget(registry, "feature", "bogus.unknown")).toBe(
      false
    );
    expect(isKnownEntitlementTarget(registry, "feature", "Bad Key!!")).toBe(
      false
    );
  });
});

describe("validators", () => {
  function assignInput(over: Partial<AssignInput> = {}): AssignInput {
    return {
      planKey: PLAN,
      offerVersion: 1,
      source: "manual",
      reason: null,
      effectiveFrom: null,
      effectiveTo: null,
      trialEndsAt: null,
      graceEndsAt: null,
      ...over
    };
  }

  test("validateAssignInput accepts a valid input and rejects bad values", () => {
    expect(validateAssignInput(assignInput())).toEqual([]);
    expect(
      validateAssignInput(assignInput({ planKey: "Bad Key" })).length
    ).toBeGreaterThan(0);
    expect(
      validateAssignInput(assignInput({ offerVersion: 0 })).length
    ).toBeGreaterThan(0);
    expect(
      validateAssignInput(assignInput({ offerVersion: 1.5 })).length
    ).toBeGreaterThan(0);
    expect(
      validateAssignInput(
        assignInput({ source: "bogus" as AssignInput["source"] })
      ).length
    ).toBeGreaterThan(0);
    expect(
      validateAssignInput(
        assignInput({
          effectiveFrom: "2026-07-19T12:00:00Z",
          effectiveTo: "2026-07-18T12:00:00Z"
        })
      ).length
    ).toBeGreaterThan(0);
  });

  const registry = resolveEntitlementKeyRegistry([
    {
      key: "m",
      name: "m",
      version: "1.0.0",
      status: "active",
      description: "",
      dependencies: [],
      serviceCatalog: {
        contributesFeatureKeys: ["f.known"],
        contributesMeterKeys: ["mtr.known"]
      }
    } as ModuleDescriptor
  ]);

  function overrideInput(over: Partial<OverrideInput> = {}): OverrideInput {
    return {
      targetKind: "feature",
      targetKey: "f.known",
      effect: "grant",
      quotaIsUnlimited: false,
      quotaLimitValue: null,
      quotaUnit: null,
      reason: "operator decision",
      source: "manual",
      effectiveFrom: null,
      effectiveTo: null,
      ...over
    };
  }

  test("validateOverrideInput accepts a valid override", () => {
    expect(validateOverrideInput(overrideInput(), registry)).toEqual([]);
  });

  test("validateOverrideInput fails closed on an UNKNOWN target key", () => {
    const errors = validateOverrideInput(
      overrideInput({ targetKey: "f.unknown" }),
      registry
    );
    expect(errors.some((e) => e.field === "targetKey")).toBe(true);
  });

  test("validateOverrideInput requires a reason", () => {
    expect(
      validateOverrideInput(overrideInput({ reason: "" }), registry).some(
        (e) => e.field === "reason"
      )
    ).toBe(true);
  });

  test("validateOverrideInput enforces quota shape (grant needs a unit + limit/unlimited)", () => {
    // quota grant missing unit + limit
    expect(
      validateOverrideInput(
        overrideInput({
          targetKind: "quota",
          targetKey: "mtr.known",
          effect: "grant"
        }),
        registry
      ).length
    ).toBeGreaterThan(0);
    // valid quota grant
    expect(
      validateOverrideInput(
        overrideInput({
          targetKind: "quota",
          targetKey: "mtr.known",
          effect: "grant",
          quotaLimitValue: 500,
          quotaUnit: "requests"
        }),
        registry
      )
    ).toEqual([]);
    // quota fields set on a non-quota override
    expect(
      validateOverrideInput(overrideInput({ quotaLimitValue: 5 }), registry)
        .length
    ).toBeGreaterThan(0);
  });

  test("isLegalTransition + requiredActionForTransition", () => {
    expect(isLegalTransition("active", "suspended")).toBe(true);
    expect(isLegalTransition("suspended", "active")).toBe(true);
    expect(isLegalTransition("active", "canceled")).toBe(true);
    expect(isLegalTransition("canceled", "active")).toBe(false);
    expect(requiredActionForTransition("canceled")).toBe("revoke");
    expect(requiredActionForTransition("suspended")).toBe("update");
    expect(requiredActionForTransition("active")).toBe("update");
  });
});

describe("request parsing — fail-closed tri-state", () => {
  test("parseAssignBody: absent scalars default, present-invalid passes through verbatim", () => {
    const parsed = parseAssignBody({ planKey: "p", offerVersion: 2 });
    expect(parsed.source).toBe("manual");
    expect(parsed.reason).toBeNull();
    expect(parsed.effectiveTo).toBeNull();

    // present-but-invalid source is passed VERBATIM (validator rejects), not coerced.
    const bad = parseAssignBody({
      planKey: "p",
      offerVersion: 1,
      source: "bogus"
    });
    expect(bad.source as string).toBe("bogus");

    // present offerVersion non-number -> NaN (validator rejects).
    const badVersion = parseAssignBody({ planKey: "p", offerVersion: "3" });
    expect(Number.isNaN(badVersion.offerVersion)).toBe(true);

    // nullable present -> verbatim (a wrong type is not coerced to null).
    const nullableWrong = parseAssignBody({
      planKey: "p",
      offerVersion: 1,
      effectiveTo: 123
    });
    expect(nullableWrong.effectiveTo).toBe(123 as unknown as string);
  });

  test("parseOverrideBody: quotaIsUnlimited fail-closed; present-invalid enum verbatim", () => {
    const parsed = parseOverrideBody({
      targetKind: "quota",
      targetKey: "m.k",
      effect: "grant",
      quotaIsUnlimited: "yes",
      quotaLimitValue: 10,
      quotaUnit: "u",
      reason: "r"
    });
    // "yes" is not coerced to boolean true — passed verbatim so the validator rejects it.
    expect(parsed.quotaIsUnlimited).toBe("yes" as unknown as boolean);

    const missingReason = parseOverrideBody({
      targetKind: "feature",
      targetKey: "x",
      effect: "deny"
    });
    expect(missingReason.reason).toBe("");
  });

  test("parseTransitionBody: present-invalid status verbatim, nullable reason", () => {
    const parsed = parseTransitionBody({ status: "frozen", reason: "x" });
    expect(parsed.status as string).toBe("frozen");
    expect(parsed.reason).toBe("x");
    const absent = parseTransitionBody({ status: "suspended" });
    expect(absent.reason).toBeNull();
  });
});

describe("Fix 6: key registry does not drift from service_catalog's", () => {
  test("resolveEntitlementKeyRegistry == resolveServiceCatalogKeyRegistry for the live registry", () => {
    const ent = resolveEntitlementKeyRegistry(listModules());
    const sc = resolveServiceCatalogKeyRegistry(listModules());
    expect([...ent.moduleKeys].sort()).toEqual([...sc.moduleKeys].sort());
    expect([...ent.featureKeys].sort()).toEqual([...sc.featureKeys].sort());
    expect([...ent.meterKeys].sort()).toEqual([...sc.meterKeys].sort());
  });
});

describe("Fix 5: override resolution cap = registry cardinality", () => {
  test("overrideResolutionCap == |moduleKeys| + |featureKeys| + |meterKeys|", () => {
    const reg = resolveEntitlementKeyRegistry(listModules());
    expect(overrideResolutionCap(listModules())).toBe(
      reg.moduleKeys.size + reg.featureKeys.size + reg.meterKeys.size
    );
    // The cap is >= the number of registered modules (a positive, non-magic bound).
    expect(overrideResolutionCap(listModules())).toBeGreaterThanOrEqual(
      listModules().length
    );
  });
});

describe("Fix 2: gated-module classification", () => {
  test("control-plane + domain/integration modules are gated; base/core/system are not", () => {
    const gated = resolveGatedModuleKeys(listModules());
    // Control-plane (default-disabled) + ordinary domain modules are gated.
    expect(gated.has("tenant_entitlement")).toBe(true);
    expect(gated.has("service_catalog")).toBe(true);
    expect(gated.has("blog_content")).toBe(true);
    // Base/core/system foundation is always-available (NOT gated).
    expect(gated.has("tenant_admin")).toBe(false);
    expect(gated.has("identity_access")).toBe(false);
    expect(gated.has("logging")).toBe(false);
    expect(gated.has("module_management")).toBe(false);
  });

  test("isEntitlementGatedModule: default-disabled OR domain/integration/derived", () => {
    expect(
      isEntitlementGatedModule({
        key: "x",
        name: "x",
        version: "1.0.0",
        status: "active",
        description: "",
        dependencies: [],
        defaultTenantState: "disabled"
      })
    ).toBe(true);
    expect(
      isEntitlementGatedModule({
        key: "x",
        name: "x",
        version: "1.0.0",
        status: "active",
        description: "",
        dependencies: [],
        type: "domain"
      })
    ).toBe(true);
    // Undefined type + default-enabled = base/always-available.
    expect(
      isEntitlementGatedModule({
        key: "x",
        name: "x",
        version: "1.0.0",
        status: "active",
        description: "",
        dependencies: []
      })
    ).toBe(false);
  });
});
