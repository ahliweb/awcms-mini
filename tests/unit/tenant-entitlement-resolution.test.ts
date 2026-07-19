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
  isKnownEntitlementTarget,
  resolveEntitlementKeyRegistry
} from "../../src/modules/tenant-entitlement/domain/entitlement-key-registry";
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
        // deny mod_b via override; mod_a depends on mod_b.
        overrides: [
          override({ targetKind: "module", targetKey: "mod_b", effect: "deny" })
        ],
        moduleDependencies: new Map([["mod_a", ["mod_b"]]])
      })
    );
    expect(isModuleEntitled(ee, "mod_b")).toBe(false);
    expect(isModuleEntitled(ee, "mod_a")).toBe(false);
    expect(ee.modules["mod_a"]!.source.kind).toBe("dependency_not_entitled");
  });

  test("a dependency OUTSIDE the entitlement set (ordinary base module) does not downgrade", () => {
    const ee = resolveEffectiveEntitlement(
      input({
        moduleDependencies: new Map([["blog_content", ["tenant_admin"]]])
      })
    );
    // tenant_admin is not an entitlement decision -> blog_content stays entitled.
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
});

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
