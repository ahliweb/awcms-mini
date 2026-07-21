/**
 * Module-registry composition validation tests. After ADR-0024 removed the
 * derived-application pathway, `validateComposedModuleRegistry`/
 * `composeModuleRegistry`/`buildComposedModuleInventory` validate a single
 * reviewed registry (the base). Every check exercised here is a
 * base-load-bearing invariant that also holds when a new domain module is
 * added directly to `src/modules/`.
 */
import { describe, expect, test } from "bun:test";

import { listBaseModules, listModules } from "../../src/modules";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";
import {
  buildComposedModuleInventory,
  composeModuleRegistry,
  formatModuleCompositionIssue,
  validateComposedModuleRegistry,
  type ModuleCompositionIssue
} from "../../src/modules/module-management/domain/module-composition";

function mod(overrides: Partial<ModuleDescriptor> = {}): ModuleDescriptor {
  return {
    key: "mod_a",
    name: "Mod A",
    version: "1.0.0",
    status: "active",
    description: "Synthetic module.",
    dependencies: [],
    ...overrides
  };
}

/** A registry is just a list of descriptors now (no base/application split). */
function registry(...modules: ModuleDescriptor[]): ModuleDescriptor[] {
  return modules;
}

describe("composeModuleRegistry — happy paths", () => {
  test("an empty-ish base-shaped registry composes to a valid registry", () => {
    const modules = [mod({ key: "a" })];
    const result = composeModuleRegistry(modules);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.registry).toEqual(modules);
    }
  });

  test("a well-formed registry with a domain module depending on base modules composes cleanly", () => {
    const result = composeModuleRegistry(
      registry(
        mod({ key: "tenant_admin" }),
        mod({ key: "identity_access" }),
        mod({
          key: "example_crm",
          type: "domain",
          dependencies: ["tenant_admin", "identity_access"],
          capabilities: { provides: ["example_crm_directory"] }
        }),
        mod({
          key: "example_loyalty",
          type: "domain",
          dependencies: ["example_crm"],
          capabilities: {
            consumes: [
              { capability: "example_crm_directory", providedBy: "example_crm" }
            ]
          }
        })
      )
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.registry.map((m) => m.key)).toEqual([
        "tenant_admin",
        "identity_access",
        "example_crm",
        "example_loyalty"
      ]);
    }
  });
});

describe("composeModuleRegistry — every rejection class", () => {
  test("self_dependency: a module depends on itself", () => {
    const result = composeModuleRegistry(
      registry(mod({ key: "a", dependencies: ["a"] }))
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "self_dependency",
        moduleKey: "a"
      });
    }
  });

  test("duplicate_dependency: a module lists the same dependency twice", () => {
    const result = composeModuleRegistry(
      registry(mod({ key: "b" }), mod({ key: "a", dependencies: ["b", "b"] }))
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "duplicate_dependency",
        moduleKey: "a",
        dependencyKey: "b"
      });
    }
  });

  test("missing_dependency: a module depends on a key that exists nowhere", () => {
    const result = composeModuleRegistry(
      registry(mod({ key: "a", dependencies: ["ghost"] }))
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "missing_dependency",
        moduleKey: "a",
        dependencyKey: "ghost"
      });
    }
  });

  test("cycle: two modules depend on each other", () => {
    const result = composeModuleRegistry(
      registry(
        mod({ key: "a", dependencies: ["b"] }),
        mod({ key: "b", dependencies: ["a"] })
      )
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const cycleIssue = result.issues.find((i) => i.type === "cycle");
      expect(cycleIssue).toBeDefined();
    }
  });

  test("duplicate_module_key: two modules share a key", () => {
    const result = composeModuleRegistry(
      registry(mod({ key: "dup" }), mod({ key: "dup" }))
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "duplicate_module_key",
        moduleKey: "dup",
        occurrences: 2
      });
    }
  });

  test("capability_provider_conflict: two modules provide the same capability name", () => {
    const result = composeModuleRegistry(
      registry(
        mod({ key: "b", capabilities: { provides: ["shared"] } }),
        mod({ key: "a", capabilities: { provides: ["shared"] } })
      )
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const issue = result.issues.find(
        (i) => i.type === "capability_provider_conflict"
      );
      expect(issue).toBeDefined();
      if (issue?.type === "capability_provider_conflict") {
        expect(issue.capability).toBe("shared");
        expect(new Set(issue.providerModuleKeys)).toEqual(new Set(["a", "b"]));
      }
    }
  });

  test("capability_provider_missing (provider_not_registered): required capability from a module that does not exist", () => {
    const result = composeModuleRegistry(
      registry(
        mod({
          key: "a",
          capabilities: {
            consumes: [{ capability: "x", providedBy: "ghost" }]
          }
        })
      )
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "capability_provider_missing",
        moduleKey: "a",
        capability: "x",
        providedBy: "ghost",
        reason: "provider_not_registered"
      });
    }
  });

  test("capability_provider_missing (provider_does_not_declare_capability): provider exists but never declares that capability", () => {
    const result = composeModuleRegistry(
      registry(
        mod({ key: "provider" }),
        mod({
          key: "a",
          capabilities: {
            consumes: [{ capability: "x", providedBy: "provider" }]
          }
        })
      )
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "capability_provider_missing",
        moduleKey: "a",
        capability: "x",
        providedBy: "provider",
        reason: "provider_does_not_declare_capability"
      });
    }
  });

  test("an optional capability consume with a missing provider does NOT fail composition", () => {
    const result = composeModuleRegistry(
      registry(
        mod({
          key: "a",
          capabilities: {
            consumes: [{ capability: "x", providedBy: "ghost", optional: true }]
          }
        })
      )
    );
    expect(result.valid).toBe(true);
  });

  test("deployment_profile_incompatible: a module claims a profile its dependency does not support", () => {
    const result = composeModuleRegistry(
      registry(
        mod({
          key: "provider",
          compatibility: { deploymentProfiles: ["production"] }
        }),
        mod({
          key: "a",
          dependencies: ["provider"],
          compatibility: { deploymentProfiles: ["offline-lan"] }
        })
      )
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "deployment_profile_incompatible",
        moduleKey: "a",
        dependencyKey: "provider",
        unsupportedProfile: "offline-lan"
      });
    }
  });

  test("a module claiming a subset of its dependency's supported profiles is compatible", () => {
    const result = composeModuleRegistry(
      registry(
        mod({
          key: "provider",
          compatibility: { deploymentProfiles: ["development", "offline-lan"] }
        }),
        mod({
          key: "a",
          dependencies: ["provider"],
          compatibility: { deploymentProfiles: ["offline-lan"] }
        })
      )
    );
    expect(result.valid).toBe(true);
  });

  test("a dependency that declares no deploymentProfiles constraint never triggers an incompatibility (absence = every profile)", () => {
    const result = composeModuleRegistry(
      registry(
        mod({ key: "provider" }),
        mod({
          key: "a",
          dependencies: ["provider"],
          compatibility: { deploymentProfiles: ["offline-lan"] }
        })
      )
    );
    expect(result.valid).toBe(true);
  });

  test("navigation_path_conflict: two modules declare the same navigation path", () => {
    const result = composeModuleRegistry(
      registry(
        mod({
          key: "b",
          navigation: [{ labelKey: "b.nav", path: "/admin/shared" }]
        }),
        mod({
          key: "a",
          navigation: [{ labelKey: "a.nav", path: "/admin/shared" }]
        })
      )
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const issue = result.issues.find(
        (i) => i.type === "navigation_path_conflict"
      );
      expect(issue).toBeDefined();
      if (issue?.type === "navigation_path_conflict") {
        expect(issue.path).toBe("/admin/shared");
        expect(new Set(issue.moduleKeys)).toEqual(new Set(["a", "b"]));
      }
    }
  });

  test("invalid_job_descriptor: a module declares a malformed job command", () => {
    const result = composeModuleRegistry(
      registry(
        mod({
          key: "a",
          jobs: [
            { command: "npm run something", purpose: "Not a bun command." }
          ]
        })
      )
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const issue = result.issues.find(
        (i) => i.type === "invalid_job_descriptor"
      );
      expect(issue).toBeDefined();
      if (issue?.type === "invalid_job_descriptor") {
        expect(issue.moduleKey).toBe("a");
        expect(issue.command).toBe("npm run something");
      }
    }
  });

  test("reports every distinct issue class in one run, not just the first", () => {
    const issues = validateComposedModuleRegistry(
      registry(
        mod({ key: "a", dependencies: ["a", "ghost"] }),
        mod({ key: "a" })
      )
    );
    const types = new Set(issues.map((i) => i.type));
    expect(types.has("self_dependency")).toBe(true);
    expect(types.has("missing_dependency")).toBe(true);
    expect(types.has("duplicate_module_key")).toBe(true);
  });
});

describe("formatModuleCompositionIssue produces a readable, non-empty message for every issue type", () => {
  const samples: ModuleCompositionIssue[] = [
    { type: "self_dependency", moduleKey: "a" },
    { type: "duplicate_dependency", moduleKey: "a", dependencyKey: "b" },
    { type: "missing_dependency", moduleKey: "a", dependencyKey: "ghost" },
    { type: "cycle", path: ["a", "b", "a"] },
    { type: "duplicate_module_key", moduleKey: "a", occurrences: 2 },
    {
      type: "capability_provider_conflict",
      capability: "x",
      providerModuleKeys: ["a", "b"]
    },
    {
      type: "capability_provider_missing",
      moduleKey: "a",
      capability: "x",
      providedBy: "b",
      reason: "provider_not_registered"
    },
    {
      type: "capability_provider_missing",
      moduleKey: "a",
      capability: "x",
      providedBy: "b",
      reason: "provider_does_not_declare_capability"
    },
    {
      type: "deployment_profile_incompatible",
      moduleKey: "a",
      dependencyKey: "b",
      unsupportedProfile: "offline-lan"
    },
    {
      type: "navigation_path_conflict",
      path: "/admin/x",
      moduleKeys: ["a", "b"]
    },
    {
      type: "invalid_job_descriptor",
      moduleKey: "a",
      command: "npm run x",
      errors: ["command must look like bun run <script>."]
    }
  ];

  for (const issue of samples) {
    test(`type "${issue.type}"${"reason" in issue ? ` (${issue.reason})` : ""}`, () => {
      const message = formatModuleCompositionIssue(issue);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    });
  }
});

describe("buildComposedModuleInventory determinism", () => {
  test("same input produces byte-identical JSON across two calls", () => {
    const input = registry(
      mod({ key: "z" }),
      mod({ key: "a" }),
      mod({ key: "m", type: "domain" })
    );
    const first = JSON.stringify(buildComposedModuleInventory(input));
    const second = JSON.stringify(buildComposedModuleInventory(input));
    expect(first).toBe(second);
  });

  test("modules are sorted by key regardless of registration order", () => {
    const inventory = buildComposedModuleInventory(
      registry(
        mod({ key: "zeta" }),
        mod({ key: "alpha" }),
        mod({ key: "mid", type: "domain" })
      )
    );
    expect(inventory.modules.map((m) => m.key)).toEqual([
      "alpha",
      "mid",
      "zeta"
    ]);
  });

  test("reflects module count, validity, and issue count", () => {
    const inventory = buildComposedModuleInventory(
      registry(
        mod({ key: "b1" }),
        mod({ key: "a1", type: "domain" }),
        mod({ key: "a2", type: "domain" })
      )
    );
    expect(inventory.moduleCount).toBe(3);
    expect(inventory.valid).toBe(true);
    expect(inventory.issueCount).toBe(0);
  });

  test("an invalid registry reports valid:false with a positive issueCount", () => {
    const inventory = buildComposedModuleInventory(
      registry(
        mod({ key: "dup", name: "First" }),
        mod({ key: "dup", name: "Second" })
      )
    );
    expect(inventory.valid).toBe(false);
    expect(inventory.issueCount).toBeGreaterThan(0);
    // Both colliding entries still appear in the diagnostic inventory.
    expect(inventory.modules.filter((m) => m.key === "dup").length).toBe(2);
  });
});

describe("the real base registry (unchanged default base build)", () => {
  test("listBaseModules() composes cleanly", () => {
    const result = composeModuleRegistry(listBaseModules());
    expect(result.valid).toBe(true);
  });

  test("listModules() (this base repository's real shipped state) is byte-identical to listBaseModules()", () => {
    expect(listModules()).toEqual(listBaseModules());
    expect(listModules().map((m) => m.key)).toEqual(
      listBaseModules().map((m) => m.key)
    );
  });
});
