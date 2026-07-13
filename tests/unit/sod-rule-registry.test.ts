/**
 * Unit tests for the SoD rule registry validation gate (Issue #746) — same
 * shape as `tests/unit/data-lifecycle-registry-validation.test.ts`. Pure
 * code — no database, no I/O.
 */
import { describe, expect, test } from "bun:test";

import type {
  ModuleDescriptor,
  SoDRuleDescriptor
} from "../../src/modules/_shared/module-contract";
import { listModules } from "../../src/modules";
import {
  collectSoDRuleDescriptors,
  formatSoDRuleRegistryIssue,
  validateSoDRuleRegistry
} from "../../src/modules/identity-access/domain/sod-rule-registry";

function buildRule(
  overrides: Partial<SoDRuleDescriptor> = {}
): SoDRuleDescriptor {
  return {
    ruleKey: "test_module.fixture_rule",
    ownerModuleKey: "test_module",
    description: "Fixture rule.",
    conflictingPermissionKeys: [
      "test_module.widgets.create",
      "test_module.widgets.approve"
    ],
    scopeApplicability: "global_within_tenant",
    severity: "medium",
    exceptionPolicy: { allowed: false },
    ...overrides
  };
}

function moduleWith(
  rules: SoDRuleDescriptor[],
  key = "test_module"
): ModuleDescriptor {
  return {
    key,
    name: "Test Module",
    version: "1.0.0",
    status: "active",
    description: "Fixture module.",
    dependencies: [],
    sodRules: rules
  };
}

describe("validateSoDRuleRegistry", () => {
  test("a well-formed rule with exceptionPolicy.allowed=false passes", () => {
    const result = validateSoDRuleRegistry([moduleWith([buildRule()])]);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("a well-formed rule with exceptionPolicy.allowed=true passes", () => {
    const rule = buildRule({
      exceptionPolicy: {
        allowed: true,
        requiresApprovalPermission: "test_module.widgets.override",
        maxDurationDays: 14
      }
    });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(true);
  });

  test("rejects ownerModuleKey that doesn't match the declaring module's own key", () => {
    const rule = buildRule({ ownerModuleKey: "someone_else" });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.message.includes("ownerModuleKey"))
    ).toBe(true);
  });

  test("rejects fewer than 2 conflictingPermissionKeys", () => {
    const rule = buildRule({
      conflictingPermissionKeys: ["test_module.widgets.create"]
    });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("at least 2"))).toBe(
      true
    );
  });

  test("rejects a malformed permission key (not module.activity.action)", () => {
    const rule = buildRule({
      conflictingPermissionKeys: [
        "not-a-permission-key",
        "test_module.widgets.approve"
      ]
    });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
  });

  test("rejects duplicate conflictingPermissionKeys", () => {
    const rule = buildRule({
      conflictingPermissionKeys: [
        "test_module.widgets.create",
        "test_module.widgets.create"
      ]
    });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("duplicates"))).toBe(
      true
    );
  });

  test("rejects an invalid scopeApplicability", () => {
    const rule = buildRule({ scopeApplicability: "bogus" as never });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
  });

  test("rejects an invalid severity", () => {
    const rule = buildRule({ severity: "bogus" as never });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
  });

  test("exceptionPolicy.allowed=true without requiresApprovalPermission/maxDurationDays fails", () => {
    const rule = buildRule({ exceptionPolicy: { allowed: true } });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
  });

  test("exceptionPolicy.allowed=false WITH requiresApprovalPermission/maxDurationDays fails — cannot declare fields that are moot", () => {
    const rule = buildRule({
      exceptionPolicy: {
        allowed: false,
        requiresApprovalPermission: "test_module.widgets.override",
        maxDurationDays: 10
      }
    });
    const result = validateSoDRuleRegistry([moduleWith([rule])]);
    expect(result.valid).toBe(false);
  });

  test("rejects a duplicate ruleKey across two modules", () => {
    const ruleA = buildRule({ ruleKey: "dup.key", ownerModuleKey: "module_a" });
    const ruleB = buildRule({ ruleKey: "dup.key", ownerModuleKey: "module_b" });
    const result = validateSoDRuleRegistry([
      moduleWith([ruleA], "module_a"),
      moduleWith([ruleB], "module_b")
    ]);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.message.includes("registered 2 times"))
    ).toBe(true);
  });

  test("a module with no sodRules field at all contributes nothing (backward compatible)", () => {
    const module: ModuleDescriptor = {
      key: "no_rules_module",
      name: "No Rules",
      version: "1.0.0",
      status: "active",
      description: "Fixture.",
      dependencies: []
    };
    const result = validateSoDRuleRegistry([module]);
    expect(result.valid).toBe(true);
    expect(result.rules).toEqual([]);
  });

  test("collectSoDRuleDescriptors flattens every module's own array, in module order", () => {
    const ruleA = buildRule({
      ruleKey: "module_a.one",
      ownerModuleKey: "module_a"
    });
    const ruleB = buildRule({
      ruleKey: "module_b.two",
      ownerModuleKey: "module_b"
    });
    const rules = collectSoDRuleDescriptors([
      moduleWith([ruleA], "module_a"),
      moduleWith([ruleB], "module_b")
    ]);
    expect(rules.map((r) => r.ruleKey)).toEqual([
      "module_a.one",
      "module_b.two"
    ]);
  });

  test("formatSoDRuleRegistryIssue produces a readable one-line string", () => {
    const formatted = formatSoDRuleRegistryIssue({
      ruleKey: "some.key",
      message: "something is wrong"
    });
    expect(formatted).toBe("[some.key] something is wrong");
  });

  test("the REAL registered registry (listModules()) validates cleanly and contains at least 3 fixtures across both global and scoped applicability", () => {
    const result = validateSoDRuleRegistry(listModules());

    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.rules.length).toBeGreaterThanOrEqual(3);

    const applicabilities = new Set(
      result.rules.map((r) => r.scopeApplicability)
    );
    expect(applicabilities.has("global_within_tenant")).toBe(true);
    expect(applicabilities.has("same_scope_only")).toBe(true);

    const ownerModules = new Set(result.rules.map((r) => r.ownerModuleKey));
    expect(ownerModules.has("identity_access")).toBe(true);
    expect(ownerModules.has("data_lifecycle")).toBe(true);
  });
});
