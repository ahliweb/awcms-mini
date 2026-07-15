/**
 * Unit tests for SoD conflict detection (Issue #746) — pure, no I/O, no
 * database. Fixture rules mirror the shapes `identity_access`/
 * `data_lifecycle` register in their own `module.ts` (`sod-rule-
 * registry.test.ts` separately validates the REAL registered fixtures).
 */
import { describe, expect, test } from "bun:test";

import type { SoDRuleDescriptor } from "../../src/modules/_shared/module-contract";
import {
  detectSoDConflicts,
  isSoDConflictExceptionCurrentlyValid
} from "../../src/modules/identity-access/domain/sod-conflict-evaluation";

const GLOBAL_RULE: SoDRuleDescriptor = {
  ruleKey: "test_module.global_rule",
  ownerModuleKey: "test_module",
  description: "Fixture global rule.",
  conflictingPermissionKeys: [
    "test_module.widgets.create",
    "test_module.widgets.approve"
  ],
  scopeApplicability: "global_within_tenant",
  severity: "high",
  exceptionPolicy: {
    allowed: true,
    requiresApprovalPermission: "test_module.widgets.override",
    maxDurationDays: 30
  }
};

const SCOPED_RULE: SoDRuleDescriptor = {
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

describe("detectSoDConflicts", () => {
  test("global_within_tenant: detects a conflict regardless of scope", () => {
    const matches = detectSoDConflicts(
      [GLOBAL_RULE],
      "test_module.widgets.approve",
      { scopeType: "office", scopeId: "scope-a" },
      [
        {
          permissionKey: "test_module.widgets.create",
          scopeType: "office",
          scopeId: "scope-b"
        }
      ]
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]!.rule.ruleKey).toBe("test_module.global_rule");
    expect(matches[0]!.indeterminate).toBe(false);
  });

  test("global_within_tenant: no conflict when the subject does not hold the other permission", () => {
    const matches = detectSoDConflicts(
      [GLOBAL_RULE],
      "test_module.widgets.approve",
      null,
      [
        {
          permissionKey: "unrelated.permission.read",
          scopeType: "office",
          scopeId: "scope-a"
        }
      ]
    );
    expect(matches).toHaveLength(0);
  });

  test("same_scope_only: detects a conflict ONLY when the fact's scope matches the requested scope", () => {
    const matchingScope = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      { scopeType: "office", scopeId: "scope-a" },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "office",
          scopeId: "scope-a"
        }
      ]
    );
    expect(matchingScope).toHaveLength(1);
    expect(matchingScope[0]!.indeterminate).toBe(false);

    const differentScope = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      { scopeType: "office", scopeId: "scope-a" },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "office",
          scopeId: "scope-b"
        }
      ]
    );
    expect(differentScope).toHaveLength(0);
  });

  test("same_scope_only: a null-scope fact (ordinary RBAC role grant, not confined to any business scope) conflicts at EVERY requested scope (security-auditor finding on PR #776)", () => {
    const matches = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      { scopeType: "office", scopeId: "scope-a" },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: null,
          scopeId: null
        }
      ]
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.indeterminate).toBe(false);

    // Same null-scope fact conflicts at a COMPLETELY different requested
    // scope too — unlike a real scoped fact, it is not confined to "scope-a".
    const otherScope = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      { scopeType: "office", scopeId: "scope-z" },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: null,
          scopeId: null
        }
      ]
    );
    expect(otherScope).toHaveLength(1);
  });

  test("same_scope_only: a fact held at a scope listed in requestedScope.relatedScopes (an ancestor/descendant of the requested scope) is treated as a scope match (Issue #794 — hierarchy-aware matching)", () => {
    const parentAncestorMatch = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      {
        scopeType: "organization_unit",
        scopeId: "child-unit",
        relatedScopes: [
          { scopeType: "organization_unit", scopeId: "parent-unit" }
        ]
      },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "organization_unit",
          scopeId: "parent-unit"
        }
      ]
    );
    expect(parentAncestorMatch).toHaveLength(1);
    expect(parentAncestorMatch[0]!.indeterminate).toBe(false);

    // A fact at a scope NOT in relatedScopes and not exactly equal is still
    // no conflict — relatedScopes narrows to genuinely-related scopes only,
    // it is not a wildcard.
    const unrelatedScope = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      {
        scopeType: "organization_unit",
        scopeId: "child-unit",
        relatedScopes: [
          { scopeType: "organization_unit", scopeId: "parent-unit" }
        ]
      },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "organization_unit",
          scopeId: "cousin-unit"
        }
      ]
    );
    expect(unrelatedScope).toHaveLength(0);
  });

  test("same_scope_only: an EMPTY/omitted relatedScopes preserves exact-match-only behavior — a caller that never resolves hierarchy (e.g. the flat office adapter) sees no change", () => {
    const noRelatedScopes = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      { scopeType: "office", scopeId: "scope-a", relatedScopes: [] },
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "office",
          scopeId: "scope-b"
        }
      ]
    );
    expect(noRelatedScopes).toHaveLength(0);
  });

  test('same_scope_only: no requestedScope supplied is INDETERMINATE, not silently "no conflict" — default-deny', () => {
    const matches = detectSoDConflicts(
      [SCOPED_RULE],
      "test_module.gadgets.revoke",
      null,
      [
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "office",
          scopeId: "scope-a"
        }
      ]
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.indeterminate).toBe(true);
  });

  test("a permission key not referenced by any rule produces zero matches", () => {
    const matches = detectSoDConflicts(
      [GLOBAL_RULE, SCOPED_RULE],
      "unrelated.module.read",
      null,
      [
        {
          permissionKey: "test_module.widgets.create",
          scopeType: "office",
          scopeId: "scope-a"
        },
        {
          permissionKey: "test_module.gadgets.create",
          scopeType: "office",
          scopeId: "scope-a"
        }
      ]
    );
    expect(matches).toEqual([]);
  });

  test("multiple rules can independently match the same requested permission", () => {
    const doubleRule: SoDRuleDescriptor = {
      ruleKey: "test_module.double_rule",
      ownerModuleKey: "test_module",
      description: "Second fixture rule sharing a conflicting key.",
      conflictingPermissionKeys: [
        "test_module.widgets.approve",
        "test_module.other.read"
      ],
      scopeApplicability: "global_within_tenant",
      severity: "low",
      exceptionPolicy: { allowed: false }
    };

    const matches = detectSoDConflicts(
      [GLOBAL_RULE, doubleRule],
      "test_module.widgets.approve",
      null,
      [
        {
          permissionKey: "test_module.widgets.create",
          scopeType: "office",
          scopeId: "a"
        },
        {
          permissionKey: "test_module.other.read",
          scopeType: "office",
          scopeId: "a"
        }
      ]
    );
    expect(matches).toHaveLength(2);
  });
});

describe("isSoDConflictExceptionCurrentlyValid", () => {
  const now = new Date("2026-06-15T00:00:00Z");

  test("a status='approved' row whose effectiveTo has already passed is NOT valid — status is a cache, timestamp is the real gate", () => {
    const valid = isSoDConflictExceptionCurrentlyValid(
      {
        status: "approved",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
        effectiveTo: new Date("2026-06-10T00:00:00Z"),
        scopeType: null,
        scopeId: null
      },
      now,
      null
    );
    expect(valid).toBe(false);
  });

  test("a currently-in-window approved row is valid", () => {
    const valid = isSoDConflictExceptionCurrentlyValid(
      {
        status: "approved",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
        effectiveTo: new Date("2026-06-30T00:00:00Z"),
        scopeType: null,
        scopeId: null
      },
      now,
      null
    );
    expect(valid).toBe(true);
  });

  test("a pending/rejected/revoked/expired status is never valid regardless of timestamps", () => {
    for (const status of ["pending", "rejected", "revoked", "expired"]) {
      const valid = isSoDConflictExceptionCurrentlyValid(
        {
          status,
          effectiveFrom: new Date("2026-06-01T00:00:00Z"),
          effectiveTo: new Date("2026-06-30T00:00:00Z"),
          scopeType: null,
          scopeId: null
        },
        now,
        null
      );
      expect(valid).toBe(false);
    }
  });

  test("a blanket exception (scopeType/scopeId null) covers every scope, including an indeterminate request", () => {
    const valid = isSoDConflictExceptionCurrentlyValid(
      {
        status: "approved",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
        effectiveTo: new Date("2026-06-30T00:00:00Z"),
        scopeType: null,
        scopeId: null
      },
      now,
      { scopeType: "office", scopeId: "any" }
    );
    expect(valid).toBe(true);
  });

  test("a scope-specific exception only covers its OWN scope", () => {
    const covered = isSoDConflictExceptionCurrentlyValid(
      {
        status: "approved",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
        effectiveTo: new Date("2026-06-30T00:00:00Z"),
        scopeType: "office",
        scopeId: "scope-a"
      },
      now,
      { scopeType: "office", scopeId: "scope-a" }
    );
    expect(covered).toBe(true);

    const notCovered = isSoDConflictExceptionCurrentlyValid(
      {
        status: "approved",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
        effectiveTo: new Date("2026-06-30T00:00:00Z"),
        scopeType: "office",
        scopeId: "scope-a"
      },
      now,
      { scopeType: "office", scopeId: "scope-b" }
    );
    expect(notCovered).toBe(false);

    const noScopeAtAll = isSoDConflictExceptionCurrentlyValid(
      {
        status: "approved",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
        effectiveTo: new Date("2026-06-30T00:00:00Z"),
        scopeType: "office",
        scopeId: "scope-a"
      },
      now,
      null
    );
    expect(noScopeAtAll).toBe(false);
  });
});
