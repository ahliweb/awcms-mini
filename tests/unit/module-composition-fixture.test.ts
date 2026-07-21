/**
 * Composition test: the LIVE base registry (`listBaseModules()`) combined
 * with the in-repo example DOMAIN modules
 * (`tests/fixtures/example-domain-modules/`, see its own README) validates
 * cleanly — proves the composition rule engine accepts domain modules added
 * to the registry (the same shape as adding one directly to `src/modules/`),
 * with their dependencies satisfied by real base modules. No database, no
 * network — composition is a pure, synchronous, in-memory operation, so this
 * test always runs (never silently skipped without `DATABASE_URL`).
 *
 * Preserves the acceptance criteria originally exercised via the derived
 * fixture (Issue #740), now reframed as domain modules composed with the
 * base:
 * - the example modules compose without modifying the base registry file —
 *   they live entirely under `tests/fixtures/`; `src/modules/index.ts` is
 *   never mutated;
 * - the composed registry passes the whole-registry DAG check;
 * - the repository inventory supports base-only AND composed modes without
 *   stale generated output;
 * - `planModuleSync` consumes the composed registry.
 */
import { describe, expect, test } from "bun:test";

import { listBaseModules, listModules } from "../../src/modules";
import { buildRepoInventoryMarkdown } from "../../scripts/repo-inventory-generate";
import {
  buildComposedModuleInventory,
  composeModuleRegistry
} from "../../src/modules/module-management/domain/module-composition";
import { validateModuleDependencyGraph } from "../../src/modules/module-management/domain/module-dependency-graph";
import { planModuleSync } from "../../src/modules/module-management/domain/descriptor-diff";
import { exampleDomainModules } from "../fixtures/example-domain-modules";

const composed = () => [...listBaseModules(), ...exampleDomainModules];

describe("base registry + example domain modules compose cleanly", () => {
  test("composition succeeds and includes all three example modules", () => {
    const result = composeModuleRegistry(composed());

    expect(result.valid).toBe(true);
    if (result.valid) {
      const keys = result.registry.map((m) => m.key);
      expect(keys).toContain("example_crm");
      expect(keys).toContain("example_loyalty");
      expect(keys).toContain("example_erp_extension");
      expect(keys.length).toBe(listBaseModules().length + 3);
    }
  });

  test("the composed registry independently passes the same whole-registry DAG check `bun run modules:dag:check` runs", () => {
    const result = composeModuleRegistry(composed());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(validateModuleDependencyGraph(result.registry)).toEqual({
        valid: true
      });
    }
  });

  test("example_loyalty's domain-to-domain lifecycle dependency on example_crm resolves inside the composed graph", () => {
    const result = composeModuleRegistry(composed());
    expect(result.valid).toBe(true);
    if (result.valid) {
      const loyalty = result.registry.find((m) => m.key === "example_loyalty");
      expect(loyalty?.dependencies).toContain("example_crm");
    }
  });

  test("the base repository's own listModules() is completely unaffected — the example modules are never registered in src/modules/index.ts", () => {
    const keys = listModules().map((m) => m.key);
    expect(keys).not.toContain("example_crm");
    expect(keys).not.toContain("example_loyalty");
    expect(keys).not.toContain("example_erp_extension");
    expect(listModules()).toEqual(listBaseModules());
  });

  test("buildComposedModuleInventory produces a deterministic snapshot that reflects the example modules' permissions/navigation/jobs/capabilities", () => {
    const inventory = buildComposedModuleInventory(composed());

    expect(inventory.valid).toBe(true);
    expect(inventory.moduleCount).toBe(listBaseModules().length + 3);

    const crm = inventory.modules.find((m) => m.key === "example_crm");
    expect(crm).toBeDefined();
    expect(crm?.type).toBe("domain");
    expect(crm?.capabilitiesProvided).toEqual(["example_crm_directory"]);
    expect(crm?.permissionCount).toBe(1);
    expect(crm?.navigationCount).toBe(1);
    expect(crm?.jobCount).toBe(1);
    expect(crm?.deploymentProfiles).toEqual(["development", "offline-lan"]);

    const loyalty = inventory.modules.find((m) => m.key === "example_loyalty");
    expect(loyalty?.capabilitiesConsumed).toEqual([
      {
        capability: "example_crm_directory",
        providedBy: "example_crm",
        optional: false
      }
    ]);

    const erpExtension = inventory.modules.find(
      (m) => m.key === "example_erp_extension"
    );
    expect(erpExtension?.type).toBe("domain");
    expect(erpExtension?.capabilitiesConsumed).toEqual([
      {
        capability: "party_directory",
        providedBy: "profile_identity",
        optional: true
      },
      {
        capability: "organization_hierarchy_resolution",
        providedBy: "organization_structure",
        optional: true
      }
    ]);
    expect(erpExtension?.permissionCount).toBe(1);
  });

  test("repository inventory generation (base-only mode) does not include the example modules", async () => {
    const markdown = await buildRepoInventoryMarkdown();
    expect(markdown).not.toContain("example_crm");
    expect(markdown).not.toContain("example_loyalty");
    expect(markdown).not.toContain("example_erp_extension");
  });

  test("repository inventory generation (composed mode) succeeds and includes the example modules, without touching the committed doc", async () => {
    const result = composeModuleRegistry(composed());
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const markdown = await buildRepoInventoryMarkdown(
      process.cwd(),
      result.registry
    );
    expect(markdown).toContain("`example_crm`");
    expect(markdown).toContain("`example_loyalty`");
    expect(markdown).toContain("`example_erp_extension`");
    // Every base module key is still present too — composed mode is
    // additive, never a replacement of the base inventory.
    for (const module of listBaseModules()) {
      expect(markdown).toContain(`\`${module.key}\``);
    }
  });

  test("module-management's descriptor-sync planning (planModuleSync) consumes the composed registry, creating an entry for every module", () => {
    const result = composeModuleRegistry(composed());
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    // Empty `existingRows` — same as a freshly-migrated instance that has
    // never run `bun run modules:sync` yet.
    const plan = planModuleSync(result.registry, []);

    expect(plan.entries.length).toBe(result.registry.length);
    expect(plan.entries.every((e) => e.action === "create")).toBe(true);
    expect(plan.entries.map((e) => e.moduleKey)).toContain("example_crm");
    expect(plan.entries.map((e) => e.moduleKey)).toContain("example_loyalty");
    expect(plan.entries.map((e) => e.moduleKey)).toContain(
      "example_erp_extension"
    );
    expect(plan.orphanedModuleKeys).toEqual([]);
  });
});
