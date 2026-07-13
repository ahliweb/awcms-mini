import { describe, expect, test } from "bun:test";

import { listBaseModules, listModules } from "../../src/modules";
import type {
  ApplicationModuleRegistry,
  ModuleDescriptor
} from "../../src/modules/_shared/module-contract";
import {
  BASE_MODULE_MIGRATION_NAMESPACE,
  buildComposedModuleInventory,
  composeModuleRegistry,
  formatModuleCompositionIssue,
  mergeModuleRegistries,
  validateComposedModuleRegistry,
  type ModuleCompositionIssue
} from "../../src/modules/module-management/domain/module-composition";

function base(overrides: Partial<ModuleDescriptor> = {}): ModuleDescriptor {
  return {
    key: "base_a",
    name: "Base A",
    version: "1.0.0",
    status: "active",
    description: "Synthetic base module.",
    dependencies: [],
    ...overrides
  };
}

function app(overrides: Partial<ModuleDescriptor> = {}): ModuleDescriptor {
  return {
    key: "app_a",
    name: "App A",
    version: "0.1.0",
    status: "experimental",
    description: "Synthetic application module.",
    dependencies: [],
    type: "derived",
    ...overrides
  };
}

function registry(
  overrides: Partial<ApplicationModuleRegistry> = {}
): ApplicationModuleRegistry {
  return {
    id: "test-application",
    modules: [app()],
    ...overrides
  };
}

describe("mergeModuleRegistries (Issue #740)", () => {
  test("no application registry: pure pass-through of base, unchanged order", () => {
    const baseModules = [base({ key: "a" }), base({ key: "b" })];
    expect(mergeModuleRegistries(baseModules, undefined)).toEqual(baseModules);
  });

  test("application modules are appended after base, each side's own order preserved", () => {
    const baseModules = [base({ key: "b1" }), base({ key: "b2" })];
    const appModules = [app({ key: "a1" }), app({ key: "a2" })];
    const merged = mergeModuleRegistries(
      baseModules,
      registry({ modules: appModules })
    );
    expect(merged.map((m) => m.key)).toEqual(["b1", "b2", "a1", "a2"]);
  });
});

describe("composeModuleRegistry — happy paths (Issue #740)", () => {
  test("no application registry composes to a valid, base-only registry", () => {
    const baseModules = [base({ key: "a" })];
    const result = composeModuleRegistry({ base: baseModules });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.registry).toEqual(baseModules);
    }
  });

  test("a well-formed application registry composes cleanly with the base", () => {
    const baseModules = [
      base({ key: "tenant_admin" }),
      base({ key: "identity_access" })
    ];
    const appModules = registry({
      modules: [
        app({
          key: "example_crm",
          dependencies: ["tenant_admin", "identity_access"],
          capabilities: { provides: ["example_crm_directory"] }
        }),
        app({
          key: "example_loyalty",
          dependencies: ["example_crm"],
          capabilities: {
            consumes: [
              { capability: "example_crm_directory", providedBy: "example_crm" }
            ]
          }
        })
      ]
    });

    const result = composeModuleRegistry({
      base: baseModules,
      application: appModules
    });
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

describe("composeModuleRegistry — every rejection class (Issue #740)", () => {
  test("self_dependency: an application module depends on itself", () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [app({ key: "a", dependencies: ["a"] })]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "self_dependency",
        moduleKey: "a"
      });
    }
  });

  test("duplicate_dependency: an application module lists the same dependency twice", () => {
    const result = composeModuleRegistry({
      base: [base({ key: "b" })],
      application: registry({
        modules: [app({ key: "a", dependencies: ["b", "b"] })]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "duplicate_dependency",
        moduleKey: "a",
        dependencyKey: "b"
      });
    }
  });

  test("missing_dependency: an application module depends on a key that exists nowhere", () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [app({ key: "a", dependencies: ["ghost"] })]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "missing_dependency",
        moduleKey: "a",
        dependencyKey: "ghost"
      });
    }
  });

  test("cycle: two application modules depend on each other", () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [
          app({ key: "a", dependencies: ["b"] }),
          app({ key: "b", dependencies: ["a"] })
        ]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const cycleIssue = result.issues.find((i) => i.type === "cycle");
      expect(cycleIssue).toBeDefined();
    }
  });

  test("duplicate_module_key: two application modules share a key that is not a base key", () => {
    const result = composeModuleRegistry({
      base: [base({ key: "unrelated" })],
      application: registry({
        modules: [app({ key: "dup" }), app({ key: "dup" })]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "duplicate_module_key",
        moduleKey: "dup",
        occurrences: 2
      });
    }
  });

  test("prohibited_base_override: an application module reuses a base module's key", () => {
    const result = composeModuleRegistry({
      base: [base({ key: "tenant_admin", type: "base" })],
      application: registry({
        modules: [app({ key: "tenant_admin" })]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "prohibited_base_override",
        moduleKey: "tenant_admin",
        baseModuleType: "base"
      });
      // Must NOT also fire the generic duplicate-key issue for the same
      // collision — most-specific-issue-wins, no redundant noise.
      expect(result.issues.some((i) => i.type === "duplicate_module_key")).toBe(
        false
      );
    }
  });

  test("prohibited_base_override fires even when the colliding base module never declared `type`", () => {
    const result = composeModuleRegistry({
      base: [base({ key: "logging" })],
      application: registry({ modules: [app({ key: "logging" })] })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "prohibited_base_override",
        moduleKey: "logging",
        baseModuleType: undefined
      });
    }
  });

  test('invalid_module_type: an application module declares type "base"', () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [app({ key: "a", type: "base" })]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "invalid_module_type",
        moduleKey: "a",
        declaredType: "base"
      });
    }
  });

  test('invalid_module_type: an application module declares type "system"', () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [app({ key: "a", type: "system" })]
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "invalid_module_type",
        moduleKey: "a",
        declaredType: "system"
      });
    }
  });

  test("capability_provider_conflict: two modules provide the same capability name", () => {
    const result = composeModuleRegistry({
      base: [base({ key: "b", capabilities: { provides: ["shared"] } })],
      application: registry({
        modules: [app({ key: "a", capabilities: { provides: ["shared"] } })]
      })
    });
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
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [
          app({
            key: "a",
            capabilities: {
              consumes: [{ capability: "x", providedBy: "ghost" }]
            }
          })
        ]
      })
    });
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
    const result = composeModuleRegistry({
      base: [base({ key: "provider" })],
      application: registry({
        modules: [
          app({
            key: "a",
            capabilities: {
              consumes: [{ capability: "x", providedBy: "provider" }]
            }
          })
        ]
      })
    });
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
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [
          app({
            key: "a",
            capabilities: {
              consumes: [
                { capability: "x", providedBy: "ghost", optional: true }
              ]
            }
          })
        ]
      })
    });
    expect(result.valid).toBe(true);
  });

  test("migration_namespace_overlap: application namespace intersects the base's reserved range", () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [],
        migrationNamespace: {
          label: "colliding-app",
          rangeStart: 50,
          rangeEnd: 60
        }
      })
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        type: "migration_namespace_overlap",
        applicationLabel: "colliding-app",
        baseLabel: BASE_MODULE_MIGRATION_NAMESPACE.label,
        overlapStart: 50,
        overlapEnd: 60
      });
    }
  });

  test("a non-overlapping migration namespace does NOT fail composition", () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [],
        migrationNamespace: {
          label: "safe-app",
          rangeStart: 900,
          rangeEnd: 999
        }
      })
    });
    expect(result.valid).toBe(true);
  });

  test("an application registry that omits migrationNamespace entirely is not checked (documented caveat, not a silent pass claim)", () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({ modules: [] })
    });
    expect(result.valid).toBe(true);
  });

  test("deployment_profile_incompatible: a module claims a profile its dependency does not support", () => {
    const result = composeModuleRegistry({
      base: [
        base({
          key: "provider",
          compatibility: { deploymentProfiles: ["production"] }
        })
      ],
      application: registry({
        modules: [
          app({
            key: "a",
            dependencies: ["provider"],
            compatibility: { deploymentProfiles: ["offline-lan"] }
          })
        ]
      })
    });
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
    const result = composeModuleRegistry({
      base: [
        base({
          key: "provider",
          compatibility: { deploymentProfiles: ["development", "offline-lan"] }
        })
      ],
      application: registry({
        modules: [
          app({
            key: "a",
            dependencies: ["provider"],
            compatibility: { deploymentProfiles: ["offline-lan"] }
          })
        ]
      })
    });
    expect(result.valid).toBe(true);
  });

  test("a dependency that declares no deploymentProfiles constraint never triggers an incompatibility (absence = every profile)", () => {
    const result = composeModuleRegistry({
      base: [base({ key: "provider" })],
      application: registry({
        modules: [
          app({
            key: "a",
            dependencies: ["provider"],
            compatibility: { deploymentProfiles: ["offline-lan"] }
          })
        ]
      })
    });
    expect(result.valid).toBe(true);
  });

  test("navigation_path_conflict: two modules declare the same navigation path", () => {
    const result = composeModuleRegistry({
      base: [
        base({
          key: "b",
          navigation: [{ labelKey: "b.nav", path: "/admin/shared" }]
        })
      ],
      application: registry({
        modules: [
          app({
            key: "a",
            navigation: [{ labelKey: "a.nav", path: "/admin/shared" }]
          })
        ]
      })
    });
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

  test("invalid_job_descriptor: a contributed module declares a malformed job command", () => {
    const result = composeModuleRegistry({
      base: [],
      application: registry({
        modules: [
          app({
            key: "a",
            jobs: [
              {
                command: "npm run something",
                purpose: "Not a bun command."
              }
            ]
          })
        ]
      })
    });
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
    const issues = validateComposedModuleRegistry({
      base: [],
      application: registry({
        modules: [
          app({ key: "a", dependencies: ["a", "ghost"] }),
          app({ key: "a" })
        ]
      })
    });
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
      type: "prohibited_base_override",
      moduleKey: "a",
      baseModuleType: "system"
    },
    { type: "invalid_module_type", moduleKey: "a", declaredType: "base" },
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
      type: "migration_namespace_overlap",
      applicationLabel: "app",
      baseLabel: "base",
      overlapStart: 1,
      overlapEnd: 5
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

describe("buildComposedModuleInventory determinism (Issue #740)", () => {
  test("same input produces byte-identical JSON across two calls", () => {
    const input = {
      base: [base({ key: "z" }), base({ key: "a" })],
      application: registry({ modules: [app({ key: "m" })] })
    };
    const first = JSON.stringify(buildComposedModuleInventory(input));
    const second = JSON.stringify(buildComposedModuleInventory(input));
    expect(first).toBe(second);
  });

  test("modules are sorted by key regardless of registration order", () => {
    const inventory = buildComposedModuleInventory({
      base: [base({ key: "zeta" }), base({ key: "alpha" })],
      application: registry({ modules: [app({ key: "mid" })] })
    });
    expect(inventory.modules.map((m) => m.key)).toEqual([
      "alpha",
      "mid",
      "zeta"
    ]);
  });

  test("reflects application registry id, module counts, and migration namespaces", () => {
    const inventory = buildComposedModuleInventory({
      base: [base({ key: "b1" })],
      application: registry({
        id: "my-app",
        modules: [app({ key: "a1" }), app({ key: "a2" })],
        migrationNamespace: { label: "my-app", rangeStart: 900, rangeEnd: 999 }
      })
    });
    expect(inventory.applicationRegistryId).toBe("my-app");
    expect(inventory.baseModuleCount).toBe(1);
    expect(inventory.applicationModuleCount).toBe(2);
    expect(inventory.totalModuleCount).toBe(3);
    expect(inventory.valid).toBe(true);
    expect(inventory.issueCount).toBe(0);
    expect(inventory.migrationNamespaces).toEqual([
      { ...BASE_MODULE_MIGRATION_NAMESPACE, source: "base" },
      { label: "my-app", rangeStart: 900, rangeEnd: 999, source: "application" }
    ]);
  });

  test("no application registry: applicationRegistryId is null and applicationModuleCount is 0", () => {
    const inventory = buildComposedModuleInventory({
      base: [base({ key: "b1" })]
    });
    expect(inventory.applicationRegistryId).toBeNull();
    expect(inventory.applicationModuleCount).toBe(0);
    expect(inventory.migrationNamespaces).toEqual([
      { ...BASE_MODULE_MIGRATION_NAMESPACE, source: "base" }
    ]);
  });

  // PR #769 security-auditor Low finding: `source` used to be attributed
  // by key membership (`baseKeys.has(m.key)`), which misreported a
  // colliding APPLICATION module as `"base"` — fixed to attribute by
  // position instead (`mergeModuleRegistries` guarantees base entries
  // come first). This inventory is still diagnostic evidence for an
  // already-INVALID (`prohibited_base_override`) result, never
  // safe-to-ship data — but the diagnostic itself must correctly identify
  // which entry is the real base module and which is the intruder.
  test("even when composition is INVALID due to a prohibited_base_override collision, the colliding entries are attributed to the correct source by position, not by key", () => {
    const inventory = buildComposedModuleInventory({
      base: [base({ key: "identity_access", name: "Real Base Module" })],
      application: registry({
        modules: [app({ key: "identity_access", name: "Evil Override" })]
      })
    });

    expect(inventory.valid).toBe(false);
    expect(inventory.issueCount).toBeGreaterThan(0);

    const collidingEntries = inventory.modules.filter(
      (m) => m.key === "identity_access"
    );
    expect(collidingEntries.length).toBe(2);

    const baseEntry = collidingEntries.find(
      (m) => m.name === "Real Base Module"
    );
    const applicationEntry = collidingEntries.find(
      (m) => m.name === "Evil Override"
    );
    expect(baseEntry?.source).toBe("base");
    expect(applicationEntry?.source).toBe("application");
  });
});

describe("the real base registry (Issue #740 acceptance: unchanged default base build)", () => {
  test("listBaseModules() composes cleanly with no application registry", () => {
    const result = composeModuleRegistry({ base: listBaseModules() });
    expect(result.valid).toBe(true);
  });

  test("listModules() (this base repository's real shipped state) is byte-identical to listBaseModules() — no application registry configured", () => {
    expect(listModules()).toEqual(listBaseModules());
    expect(listModules().map((m) => m.key)).toEqual(
      listBaseModules().map((m) => m.key)
    );
  });
});
