/**
 * Differential (old-vs-new) equivalence tests for SoD conflict detection's
 * hoisted index (Issue #833, epic #818).
 *
 * #833 is a PERFORMANCE issue on a SECURITY path: `detectSoDConflicts`
 * decides whether a dangerous combination of permissions is refused, so an
 * optimization that changes WHICH conflicts are detected is a security
 * hole, not a speedup. This module also has a documented history of exactly
 * that class of defect (#794/#800/#802 — a `same_scope_only` rule that
 * matched on exact `(scopeType, scopeId)` equality only, silently missing a
 * hierarchically-related scope).
 *
 * `LEGACY_detectSoDConflicts` below is a LITERAL transcription of the
 * implementation as it stood at `origin/main` immediately before #833 (see
 * `git show origin/main:src/modules/identity-access/domain/
 * sod-conflict-evaluation.ts`). It is intentionally the naive
 * O(P×R×K×F×S) version — do NOT "optimize", tidy, or share helpers with
 * the production code here. Its whole value is being an INDEPENDENT
 * oracle; the moment it shares code with the thing it checks, it stops
 * proving anything.
 *
 * The randomized sweep compares the two implementations on identical
 * inputs, order-sensitively, across ~4000 generated cases covering: rules
 * that do/don't trigger, duplicate keys inside `conflictingPermissionKeys`,
 * every `scopeApplicability`, absent/present/undefined `relatedScopes`,
 * null-scope (ordinary RBAC) facts, half-null fact scopes, and a missing
 * `requestedScope` (the indeterminate default-deny path).
 */
import { describe, expect, test } from "bun:test";

import type { SoDRuleDescriptor } from "../../src/modules/_shared/module-contract";
import {
  createSoDConflictEvaluator,
  detectSoDConflicts,
  type RequestedScope,
  type SoDAssignmentFact,
  type SoDConflictMatch
} from "../../src/modules/identity-access/domain/sod-conflict-evaluation";

// ---------------------------------------------------------------------------
// The pre-#833 implementation, transcribed verbatim as an oracle.
// ---------------------------------------------------------------------------
function LEGACY_detectSoDConflicts(
  rules: readonly SoDRuleDescriptor[],
  requestedPermissionKey: string,
  requestedScope: RequestedScope | null,
  subjectFacts: readonly SoDAssignmentFact[]
): SoDConflictMatch[] {
  const matches: SoDConflictMatch[] = [];

  for (const rule of rules) {
    if (!rule.conflictingPermissionKeys.includes(requestedPermissionKey)) {
      continue;
    }

    const otherKeys = rule.conflictingPermissionKeys.filter(
      (key) => key !== requestedPermissionKey
    );

    for (const otherKey of otherKeys) {
      const holdingFacts = subjectFacts.filter(
        (fact) => fact.permissionKey === otherKey
      );

      if (holdingFacts.length === 0) {
        continue;
      }

      if (rule.scopeApplicability === "same_scope_only") {
        if (!requestedScope) {
          matches.push({
            rule,
            conflictingPermissionKey: otherKey,
            indeterminate: true
          });
          continue;
        }

        const scopedMatch = holdingFacts.some(
          (fact) =>
            (fact.scopeType === null && fact.scopeId === null) ||
            (fact.scopeType === requestedScope.scopeType &&
              fact.scopeId === requestedScope.scopeId) ||
            (requestedScope.relatedScopes ?? []).some(
              (related) =>
                related.scopeType === fact.scopeType &&
                related.scopeId === fact.scopeId
            )
        );

        if (scopedMatch) {
          matches.push({
            rule,
            conflictingPermissionKey: otherKey,
            indeterminate: false
          });
        }
        continue;
      }

      matches.push({
        rule,
        conflictingPermissionKey: otherKey,
        indeterminate: false
      });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Deterministic input generation (seeded — a failure is always replayable).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERMISSION_KEYS = [
  "identity_access.business_scope_assignments.create",
  "identity_access.business_scope_assignments.revoke",
  "data_lifecycle.legal_hold.create",
  "data_lifecycle.legal_hold.release",
  "test_module.widgets.create",
  "test_module.widgets.approve",
  "test_module.gadgets.create",
  "test_module.gadgets.revoke"
];

const SCOPE_TYPES = ["organization_unit", "legal_entity", "office"];
const SCOPE_IDS = ["scope-a", "scope-b", "scope-c", "scope-d"];

const SCOPE_APPLICABILITIES: SoDRuleDescriptor["scopeApplicability"][] = [
  "same_scope_only",
  "global_within_tenant",
  "any"
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function generateRules(rng: () => number): SoDRuleDescriptor[] {
  const count = Math.floor(rng() * 6);
  const rules: SoDRuleDescriptor[] = [];

  for (let index = 0; index < count; index += 1) {
    const keyCount = 2 + Math.floor(rng() * 3);
    const conflictingPermissionKeys: string[] = [];
    for (let k = 0; k < keyCount; k += 1) {
      // Duplicates are deliberately possible — the index build dedupes the
      // TRIGGER side but must keep duplicate OTHER keys, matching legacy.
      conflictingPermissionKeys.push(pick(rng, PERMISSION_KEYS));
    }

    rules.push({
      ruleKey: `generated_rule_${index}`,
      ownerModuleKey: "test_module",
      description: "Generated fixture rule.",
      conflictingPermissionKeys,
      scopeApplicability: pick(rng, SCOPE_APPLICABILITIES),
      severity: pick(rng, ["low", "medium", "high", "critical"] as const),
      exceptionPolicy: { allowed: false }
    });
  }

  return rules;
}

function generateFacts(rng: () => number): SoDAssignmentFact[] {
  const count = Math.floor(rng() * 12);
  const facts: SoDAssignmentFact[] = [];

  for (let index = 0; index < count; index += 1) {
    const shape = rng();
    let scopeType: string | null;
    let scopeId: string | null;

    if (shape < 0.3) {
      // Ordinary RBAC grant — unscoped, conflicts at EVERY scope.
      scopeType = null;
      scopeId = null;
    } else if (shape < 0.4) {
      // Half-null: impossible via the real resolvers, but the pure
      // function must not diverge on it either.
      scopeType = pick(rng, SCOPE_TYPES);
      scopeId = null;
    } else {
      scopeType = pick(rng, SCOPE_TYPES);
      scopeId = pick(rng, SCOPE_IDS);
    }

    facts.push({
      permissionKey: pick(rng, PERMISSION_KEYS),
      scopeType,
      scopeId
    });
  }

  return facts;
}

function generateRequestedScope(rng: () => number): RequestedScope | null {
  const shape = rng();
  if (shape < 0.2) {
    // No scope at all — the indeterminate/default-deny path.
    return null;
  }

  const scope: RequestedScope = {
    scopeType: pick(rng, SCOPE_TYPES),
    scopeId: pick(rng, SCOPE_IDS)
  };

  if (shape < 0.4) {
    // `relatedScopes` omitted entirely (flat adapter, e.g. "office").
    return scope;
  }

  const relatedCount = Math.floor(rng() * 4);
  const relatedScopes: { scopeType: string; scopeId: string }[] = [];
  for (let index = 0; index < relatedCount; index += 1) {
    relatedScopes.push({
      scopeType: pick(rng, SCOPE_TYPES),
      scopeId: pick(rng, SCOPE_IDS)
    });
  }

  return { ...scope, relatedScopes };
}

describe("detectSoDConflicts index equivalence (Issue #833)", () => {
  test("randomized sweep: new indexed detection equals the pre-#833 scan, order included", () => {
    const rng = mulberry32(0x833);
    let casesWithMatches = 0;
    let sameScopeOnlyMatches = 0;
    let hierarchyMatches = 0;
    let indeterminateMatches = 0;

    for (let iteration = 0; iteration < 4000; iteration += 1) {
      const rules = generateRules(rng);
      const requestedScope = generateRequestedScope(rng);
      const subjectFacts = generateFacts(rng);
      const requestedPermissionKey = pick(rng, PERMISSION_KEYS);

      const legacy = LEGACY_detectSoDConflicts(
        rules,
        requestedPermissionKey,
        requestedScope,
        subjectFacts
      );
      const indexed = detectSoDConflicts(
        rules,
        requestedPermissionKey,
        requestedScope,
        subjectFacts
      );

      // `toEqual` on the whole array is order-sensitive and compares the
      // rule objects too — a reordered, duplicated, or dropped match fails.
      expect({
        iteration,
        matches: indexed
      }).toEqual({ iteration, matches: legacy });

      if (legacy.length > 0) {
        casesWithMatches += 1;
      }
      for (const match of legacy) {
        if (match.indeterminate) {
          indeterminateMatches += 1;
        }
        if (match.rule.scopeApplicability === "same_scope_only") {
          sameScopeOnlyMatches += 1;
          if (
            !match.indeterminate &&
            requestedScope?.relatedScopes &&
            requestedScope.relatedScopes.length > 0
          ) {
            hierarchyMatches += 1;
          }
        }
      }
    }

    // The sweep is worthless if it only ever compared empty results —
    // assert the generator actually reached each interesting branch.
    expect(casesWithMatches).toBeGreaterThan(100);
    expect(sameScopeOnlyMatches).toBeGreaterThan(50);
    expect(hierarchyMatches).toBeGreaterThan(10);
    expect(indeterminateMatches).toBeGreaterThan(10);
  });

  test("hoisted evaluator equals a per-key legacy scan across a whole role's permission set", () => {
    const rng = mulberry32(0xc0ffee);

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const rules = generateRules(rng);
      const requestedScope = generateRequestedScope(rng);
      const subjectFacts = generateFacts(rng);

      // The real caller's shape: ONE evaluator reused for every permission
      // key the assigned role grants.
      const evaluator = createSoDConflictEvaluator(
        rules,
        requestedScope,
        subjectFacts
      );

      for (const permissionKey of PERMISSION_KEYS) {
        expect(evaluator.detect(permissionKey)).toEqual(
          LEGACY_detectSoDConflicts(
            rules,
            permissionKey,
            requestedScope,
            subjectFacts
          )
        );
      }
    }
  });

  test("reusing one evaluator does not let earlier keys leak into later ones", () => {
    const rule: SoDRuleDescriptor = {
      ruleKey: "test_module.scoped_rule",
      ownerModuleKey: "test_module",
      description: "Fixture same-scope-only rule.",
      conflictingPermissionKeys: [
        "test_module.gadgets.create",
        "test_module.gadgets.revoke"
      ],
      scopeApplicability: "same_scope_only",
      severity: "medium",
      exceptionPolicy: { allowed: false }
    };

    const evaluator = createSoDConflictEvaluator(
      [rule],
      { scopeType: "office", scopeId: "scope-a" },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "office",
          scopeId: "scope-a"
        }
      ]
    );

    // Same evaluator, repeated and interleaved calls — each key's result
    // must be independent of what was asked before it.
    expect(evaluator.detect("test_module.gadgets.revoke")).toHaveLength(1);
    expect(evaluator.detect("test_module.widgets.approve")).toHaveLength(0);
    expect(evaluator.detect("test_module.gadgets.revoke")).toHaveLength(1);
    expect(evaluator.detect("test_module.gadgets.create")).toHaveLength(0);
    expect(evaluator.detect("test_module.gadgets.revoke")).toHaveLength(1);
  });
});

describe("detectSoDConflicts hierarchy regression pins (Issues #794, #833)", () => {
  const SCOPED_RULE: SoDRuleDescriptor = {
    ruleKey: "identity_access.business_scope_assignment_scope_maker_checker",
    ownerModuleKey: "identity_access",
    description: "Fixture same-scope-only rule.",
    conflictingPermissionKeys: [
      "identity_access.business_scope_assignments.create",
      "identity_access.business_scope_assignments.revoke"
    ],
    scopeApplicability: "same_scope_only",
    severity: "high",
    exceptionPolicy: { allowed: false }
  };

  const REQUESTED = "identity_access.business_scope_assignments.revoke";
  const HELD = "identity_access.business_scope_assignments.create";

  function detectAgainstFact(
    fact: SoDAssignmentFact,
    requestedScope: RequestedScope | null
  ) {
    return detectSoDConflicts([SCOPED_RULE], REQUESTED, requestedScope, [fact]);
  }

  test("#794: a fact held at an ancestor scope still matches through the Set index", () => {
    const matches = detectAgainstFact(
      {
        permissionKey: HELD,
        scopeType: "organization_unit",
        scopeId: "parent"
      },
      {
        scopeType: "organization_unit",
        scopeId: "child",
        relatedScopes: [{ scopeType: "organization_unit", scopeId: "parent" }]
      }
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.indeterminate).toBe(false);
  });

  test("same_scope_only: exact scope equality still matches without relatedScopes", () => {
    const matches = detectAgainstFact(
      { permissionKey: HELD, scopeType: "office", scopeId: "scope-a" },
      { scopeType: "office", scopeId: "scope-a" }
    );

    expect(matches).toHaveLength(1);
  });

  test("same_scope_only: a genuinely unrelated scope still does NOT match", () => {
    const matches = detectAgainstFact(
      { permissionKey: HELD, scopeType: "organization_unit", scopeId: "other" },
      {
        scopeType: "organization_unit",
        scopeId: "child",
        relatedScopes: [{ scopeType: "organization_unit", scopeId: "parent" }]
      }
    );

    expect(matches).toHaveLength(0);
  });

  test("same_scope_only: a null-scope RBAC fact still matches every requested scope", () => {
    const matches = detectAgainstFact(
      { permissionKey: HELD, scopeType: null, scopeId: null },
      { scopeType: "organization_unit", scopeId: "child", relatedScopes: [] }
    );

    expect(matches).toHaveLength(1);
  });

  test("same_scope_only: a missing requestedScope is still INDETERMINATE, not 'no conflict'", () => {
    const matches = detectAgainstFact(
      { permissionKey: HELD, scopeType: "office", scopeId: "scope-a" },
      null
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.indeterminate).toBe(true);
  });

  test("scope keys cannot collide across the scopeType/scopeId boundary", () => {
    // A composite index key built by naive concatenation could make
    // ("ab", "c") and ("a", "bc") look like the same scope, turning an
    // unrelated scope into a false hierarchy match.
    const matches = detectAgainstFact(
      { permissionKey: HELD, scopeType: "ab", scopeId: "c" },
      {
        scopeType: "organization_unit",
        scopeId: "child",
        relatedScopes: [{ scopeType: "a", scopeId: "bc" }]
      }
    );

    expect(matches).toHaveLength(0);
  });
});
