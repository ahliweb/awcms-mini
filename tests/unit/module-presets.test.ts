import { describe, expect, test } from "bun:test";

import {
  computeModulePresetPlan,
  findModulePreset,
  MODULE_PRESETS,
  resolveProtectedModuleKeys,
  type ModulePresetDefinition
} from "../../src/modules/module-management/domain/module-presets";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";
import type { ModuleTenantState } from "../../src/modules/module-management/domain/tenant-module-lifecycle";

function descriptor(
  overrides: Partial<ModuleDescriptor> = {}
): ModuleDescriptor {
  return {
    key: "a",
    name: "A",
    version: "1.0.0",
    status: "active",
    description: "Module A.",
    dependencies: [],
    ...overrides
  };
}

function state(moduleKey: string, tenantEnabled: boolean): ModuleTenantState {
  return { moduleKey, tenantEnabled };
}

function preset(
  overrides: Partial<ModulePresetDefinition> = {}
): ModulePresetDefinition {
  return {
    name: "minimal",
    label: "Test preset",
    description: "Test preset.",
    enabledModuleKeys: [],
    ...overrides
  };
}

// A small synthetic registry mirroring the real shape closely enough to
// exercise every branch: `core` is isCore, `foundation` is core's own
// dependency (protected transitively), `leaf_a`/`leaf_b` are independent
// optional modules, `dependent` depends on `leaf_a` (an optional module,
// not core) so enabling it without `leaf_a` already enabled must fail
// rather than silently auto-enabling `leaf_a`.
const CORE: ModuleDescriptor = descriptor({
  key: "core",
  isCore: true,
  dependencies: ["foundation"]
});
const FOUNDATION: ModuleDescriptor = descriptor({
  key: "foundation",
  dependencies: []
});
const LEAF_A: ModuleDescriptor = descriptor({
  key: "leaf_a",
  dependencies: ["foundation"]
});
const LEAF_B: ModuleDescriptor = descriptor({
  key: "leaf_b",
  dependencies: ["foundation"]
});
const DEPENDENT: ModuleDescriptor = descriptor({
  key: "dependent",
  dependencies: ["leaf_a"]
});

const REGISTRY: readonly ModuleDescriptor[] = [
  CORE,
  FOUNDATION,
  LEAF_A,
  LEAF_B,
  DEPENDENT
];

describe("MODULE_PRESETS / findModulePreset", () => {
  test("every defined preset resolves to real registered module keys (this repo's actual registry)", async () => {
    // Cross-check against the real, live module registry — catches the
    // exact class of bug the issue itself warned about (a preset
    // referencing a module key, like the issue's own illustrative
    // `workflow_approval`, that doesn't actually resolve via
    // `listModules()`).
    const { listModules } = await import("../../src/modules/index");
    const realDescriptors = listModules();
    const realKeys = new Set(realDescriptors.map((d) => d.key));

    for (const p of MODULE_PRESETS) {
      for (const key of p.enabledModuleKeys) {
        expect(realKeys.has(key)).toBe(true);
      }
    }
  });

  test("findModulePreset resolves a known preset name", () => {
    expect(findModulePreset("online_website")?.name).toBe("online_website");
  });

  test("findModulePreset returns null for an unknown preset name", () => {
    expect(findModulePreset("does_not_exist")).toBeNull();
  });

  test("minimal preset's own enabledModuleKeys list is empty (core-only by construction)", () => {
    expect(findModulePreset("minimal")?.enabledModuleKeys).toEqual([]);
  });

  test("news_portal_full_online_r2 (Issue #632) is a distinct preset from news_portal, listing blog_content/tenant_domain/visitor_analytics/module_management/identity_access/news_portal", () => {
    const preset = findModulePreset("news_portal_full_online_r2");

    expect(preset).not.toBeNull();
    expect(preset?.enabledModuleKeys).toEqual([
      "blog_content",
      "tenant_domain",
      "visitor_analytics",
      "module_management",
      "identity_access",
      "news_portal"
    ]);
    // Genuinely a different preset from the pre-existing "news_portal" one
    // (Issue #565) — not a rename/merge.
    expect(findModulePreset("news_portal")?.enabledModuleKeys).not.toEqual(
      preset?.enabledModuleKeys
    );
  });
});

describe("resolveProtectedModuleKeys", () => {
  test("includes isCore keys and their full transitive dependency closure", () => {
    const result = resolveProtectedModuleKeys(REGISTRY);

    expect(result).toEqual(new Set(["core", "foundation"]));
  });

  test("does not include non-core, non-depended-upon modules", () => {
    const result = resolveProtectedModuleKeys(REGISTRY);

    expect(result.has("leaf_a")).toBe(false);
    expect(result.has("leaf_b")).toBe(false);
    expect(result.has("dependent")).toBe(false);
  });

  test("real registry's protected set is exactly module_management's own dependency closure", async () => {
    const { listModules } = await import("../../src/modules/index");
    const result = resolveProtectedModuleKeys(listModules());

    expect(result).toEqual(
      new Set([
        "module_management",
        "tenant_admin",
        "identity_access",
        "profile_identity"
      ])
    );
  });
});

describe("computeModulePresetPlan — normal application", () => {
  test("plans to enable every listed module not already enabled, dependencies-first", () => {
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["leaf_a", "dependent"] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", false),
        state("leaf_b", true),
        state("dependent", false)
      ]
    });

    expect(plan.toEnable).toEqual(["leaf_a", "dependent"]);
  });

  test("plans to disable currently-enabled, non-protected, non-listed modules", () => {
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["leaf_a"] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", false),
        state("leaf_b", true),
        state("dependent", false)
      ]
    });

    expect(plan.toEnable).toEqual(["leaf_a"]);
    expect(plan.toDisable).toEqual(["leaf_b"]);
  });

  test("never plans to disable core or its dependency closure, even when not listed by the preset", () => {
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: [] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", true),
        state("leaf_b", true),
        state("dependent", false)
      ]
    });

    expect(plan.toDisable).not.toContain("core");
    expect(plan.toDisable).not.toContain("foundation");
    expect([...plan.protectedModuleKeys].sort()).toEqual([
      "core",
      "foundation"
    ]);
  });
});

describe("computeModulePresetPlan — idempotent re-application", () => {
  test("second application against a state that already matches the preset plans no changes", () => {
    const currentState: ModuleTenantState[] = [
      state("core", true),
      state("foundation", true),
      state("leaf_a", true),
      state("leaf_b", false),
      state("dependent", false)
    ];

    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["leaf_a"] }),
      allDescriptors: REGISTRY,
      currentState
    });

    expect(plan.toEnable).toEqual([]);
    expect(plan.toDisable).toEqual([]);
  });
});

describe("computeModulePresetPlan — a listed module's dependency that isn't itself in the preset", () => {
  test("is included in toEnable as-is without auto-adding the missing dependency (no invented resolution logic)", () => {
    // `dependent` needs `leaf_a`, but the preset only lists `dependent`.
    // `leaf_a` is currently disabled for this tenant (e.g. a previous
    // preset application disabled it). The plan must still include
    // `dependent` in toEnable (best-effort) — it is the application
    // layer's job (via the real `enableTenantModule`/
    // `evaluateModuleEnable`) to surface the resulting
    // `MODULE_DEPENDENCY_DISABLED` rejection, not this pure planner's job
    // to silently add `leaf_a` to the plan.
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["dependent"] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", false),
        state("leaf_b", true),
        state("dependent", false)
      ]
    });

    expect(plan.toEnable).toEqual(["dependent"]);
    expect(plan.toEnable).not.toContain("leaf_a");
  });

  test("when the dependency IS in the preset list, it is ordered before its dependent", () => {
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["dependent", "leaf_a"] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", false),
        state("leaf_b", true),
        state("dependent", false)
      ]
    });

    expect(plan.toEnable).toEqual(["leaf_a", "dependent"]);
  });
});

describe("computeModulePresetPlan — disabling a module another still-enabled module depends on", () => {
  test("skips (does not plan to disable) a module a preset-kept module still depends on, and reports it in skippedDisable", () => {
    // `dependent` stays enabled by this preset (listed), and `dependent`
    // depends on `leaf_a`. `leaf_a` itself is NOT listed by this preset,
    // so it would otherwise be a disable candidate — but it must be
    // skipped, not force-disabled, since `dependent` still needs it.
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["dependent"] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", true),
        state("leaf_b", false),
        state("dependent", true)
      ]
    });

    expect(plan.toDisable).not.toContain("leaf_a");
    expect(plan.skippedDisable).toEqual([
      { moduleKey: "leaf_a", reason: "reverse_dependency_active" }
    ]);
  });

  test("disables in leaves-first order so a real dependent gets disabled before its own dependency", () => {
    // Switching a preset from one that wants `dependent` + `leaf_a` to one
    // that wants neither: `dependent` has no dependents itself, so it must
    // be ordered before `leaf_a` (which `dependent` depends on).
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: [] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", true),
        state("leaf_b", false),
        state("dependent", true)
      ]
    });

    expect(plan.toDisable.indexOf("dependent")).toBeLessThan(
      plan.toDisable.indexOf("leaf_a")
    );
    expect(plan.skippedDisable).toEqual([]);
  });

  test("skips a disable candidate that only a module THIS SAME PLAN is about to newly enable depends on (post-review regression)", () => {
    // `dependent` starts DISABLED and is listed by this preset (so it's a
    // toEnable candidate, not already-enabled). `leaf_a` starts ENABLED and
    // is NOT listed (so it would otherwise be a disable candidate). Since
    // this plan is about to enable `dependent`, which depends on `leaf_a`,
    // `leaf_a` must be skipped — not scheduled for disable — even though
    // nothing CURRENTLY enabled depends on it yet. Before the post-review
    // fix, the disable-planner only seeded its "stays enabled" set from
    // pre-plan state, so this case incorrectly scheduled leaf_a for
    // disable; the real disableTenantModule call would still have caught
    // it, but as a spurious MODULE_REVERSE_DEPENDENCY_ACTIVE rejection
    // instead of this pre-emptive skip.
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["dependent"] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", true),
        state("leaf_b", false),
        state("dependent", false)
      ]
    });

    expect(plan.toEnable).toContain("dependent");
    expect(plan.toDisable).not.toContain("leaf_a");
    expect(plan.skippedDisable).toEqual([
      { moduleKey: "leaf_a", reason: "reverse_dependency_active" }
    ]);
  });
});

describe("computeModulePresetPlan — unknown module keys", () => {
  test("a preset-listed key that isn't a registered descriptor is reported, never silently enabled", () => {
    const plan = computeModulePresetPlan({
      preset: preset({ enabledModuleKeys: ["leaf_a", "workflow_approval"] }),
      allDescriptors: REGISTRY,
      currentState: [
        state("core", true),
        state("foundation", true),
        state("leaf_a", false),
        state("leaf_b", true),
        state("dependent", false)
      ]
    });

    expect(plan.unknownModuleKeys).toEqual(["workflow_approval"]);
    expect(plan.toEnable).not.toContain("workflow_approval");
  });
});

describe("computeModulePresetPlan — switching between presets end-to-end (synthetic registry)", () => {
  test("applying a broader preset then a narrower one enables the broad set then disables what the narrow one drops", () => {
    const broad = preset({
      enabledModuleKeys: ["leaf_a", "leaf_b", "dependent"]
    });
    const narrow = preset({ enabledModuleKeys: ["leaf_a"] });

    const initialState: ModuleTenantState[] = [
      state("core", true),
      state("foundation", true),
      state("leaf_a", false),
      state("leaf_b", false),
      state("dependent", false)
    ];

    const broadPlan = computeModulePresetPlan({
      preset: broad,
      allDescriptors: REGISTRY,
      currentState: initialState
    });
    expect([...broadPlan.toEnable].sort()).toEqual([
      "dependent",
      "leaf_a",
      "leaf_b"
    ]);
    expect(broadPlan.toDisable).toEqual([]);

    // Simulate the state after broadPlan's enables landed.
    const afterBroad: ModuleTenantState[] = [
      state("core", true),
      state("foundation", true),
      state("leaf_a", true),
      state("leaf_b", true),
      state("dependent", true)
    ];

    const narrowPlan = computeModulePresetPlan({
      preset: narrow,
      allDescriptors: REGISTRY,
      currentState: afterBroad
    });
    expect(narrowPlan.toEnable).toEqual([]);
    // `dependent` must be disabled before `leaf_a` would even be a
    // candidate to disable — but `leaf_a` is kept by the narrow preset, so
    // only `leaf_b` and `dependent` are disable candidates.
    expect([...narrowPlan.toDisable].sort()).toEqual(["dependent", "leaf_b"]);
    expect(narrowPlan.toDisable.indexOf("dependent")).toBeGreaterThanOrEqual(0);
  });
});
