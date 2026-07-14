/**
 * Integration/build proof for Issue #740's composition API, using the
 * in-repo fixture derived application
 * (`tests/fixtures/derived-application-example/`, see its own README for
 * what it illustrates). No database, no network — composition is a pure,
 * synchronous, in-memory operation, so this test always runs (never
 * silently skipped without `DATABASE_URL`, unlike this repo's
 * `*.integration.test.ts` suite).
 *
 * Proves the acceptance criteria this issue names explicitly:
 * - "A derived fixture composes modules without modifying the base
 *   registry file" — the fixture lives entirely under `tests/fixtures/`;
 *   `src/modules/index.ts` and `src/modules/application-registry.ts` are
 *   never imported or mutated by this file.
 * - "At least one integration/build test proves an external fixture can
 *   compile and pass module DAG checks" — TypeScript already compiled the
 *   fixture to get here (`bun run typecheck`/`bun test` both require valid
 *   syntax/types), and this file additionally re-runs
 *   `validateModuleDependencyGraph` (the same whole-registry check
 *   `bun run modules:dag:check` runs) against the composed result.
 * - "Repository inventory supports base-only and composed-fixture modes
 *   without stale generated output" — `buildRepoInventoryMarkdown` is
 *   exercised against the composed (base + fixture) registry, proving it
 *   does not crash and reflects contributed modules, without touching the
 *   committed `docs/awcms-mini/repo-inventory.md` (a different, in-memory
 *   module list is passed explicitly).
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
import { exampleApplicationModuleRegistry } from "../fixtures/derived-application-example/application-registry";

describe("derived-application-example fixture composes with the base registry (Issue #740)", () => {
  test("composition succeeds and includes both fixture modules", () => {
    const result = composeModuleRegistry({
      base: listBaseModules(),
      application: exampleApplicationModuleRegistry
    });

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
    const result = composeModuleRegistry({
      base: listBaseModules(),
      application: exampleApplicationModuleRegistry
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(validateModuleDependencyGraph(result.registry)).toEqual({
        valid: true
      });
    }
  });

  test("example_loyalty's application-to-application lifecycle dependency on example_crm resolves inside the composed graph", () => {
    const result = composeModuleRegistry({
      base: listBaseModules(),
      application: exampleApplicationModuleRegistry
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      const loyalty = result.registry.find((m) => m.key === "example_loyalty");
      expect(loyalty?.dependencies).toContain("example_crm");
    }
  });

  test("the base repository's own listModules() is completely unaffected — the fixture is never wired into src/modules/application-registry.ts", () => {
    const keys = listModules().map((m) => m.key);
    expect(keys).not.toContain("example_crm");
    expect(keys).not.toContain("example_loyalty");
    expect(keys).not.toContain("example_erp_extension");
    expect(listModules()).toEqual(listBaseModules());
  });

  test("buildComposedModuleInventory produces a deterministic snapshot that reflects both fixture modules' permissions/navigation/jobs/capabilities", () => {
    const inventory = buildComposedModuleInventory({
      base: listBaseModules(),
      application: exampleApplicationModuleRegistry
    });

    expect(inventory.valid).toBe(true);
    expect(inventory.applicationRegistryId).toBe(
      exampleApplicationModuleRegistry.id
    );
    expect(inventory.applicationModuleCount).toBe(3);

    const crm = inventory.modules.find((m) => m.key === "example_crm");
    expect(crm).toBeDefined();
    expect(crm?.source).toBe("application");
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
    expect(erpExtension?.source).toBe("application");
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

    expect(inventory.migrationNamespaces).toContainEqual({
      ...exampleApplicationModuleRegistry.migrationNamespace!,
      source: "application"
    });
  });

  test("repository inventory generation (base-only mode) does not include fixture modules", async () => {
    const markdown = await buildRepoInventoryMarkdown();
    expect(markdown).not.toContain("example_crm");
    expect(markdown).not.toContain("example_loyalty");
    expect(markdown).not.toContain("example_erp_extension");
  });

  test("repository inventory generation (composed-fixture mode) succeeds and includes the fixture's contributed modules, without touching the committed doc", async () => {
    const composed = composeModuleRegistry({
      base: listBaseModules(),
      application: exampleApplicationModuleRegistry
    });
    expect(composed.valid).toBe(true);
    if (!composed.valid) return;

    const markdown = await buildRepoInventoryMarkdown(
      process.cwd(),
      composed.registry
    );
    expect(markdown).toContain("`example_crm`");
    expect(markdown).toContain("`example_loyalty`");
    expect(markdown).toContain("`example_erp_extension`");
    // Every base module key is still present too — composed-fixture mode
    // is additive, never a replacement of the base inventory.
    for (const module of listBaseModules()) {
      expect(markdown).toContain(`\`${module.key}\``);
    }
  });

  test("module-management's descriptor-sync planning (planModuleSync) consumes the composed registry, creating an entry for every contributed module — Issue #740 acceptance: sync consumes the composed registry, not a duplicate source", () => {
    const composed = composeModuleRegistry({
      base: listBaseModules(),
      application: exampleApplicationModuleRegistry
    });
    expect(composed.valid).toBe(true);
    if (!composed.valid) return;

    // Empty `existingRows` — same as a freshly-migrated instance that has
    // never run `bun run modules:sync` yet (`module-management/README.md`'s
    // own documented "sync first" scenario).
    const plan = planModuleSync(composed.registry, []);

    expect(plan.entries.length).toBe(composed.registry.length);
    expect(plan.entries.every((e) => e.action === "create")).toBe(true);
    expect(plan.entries.map((e) => e.moduleKey)).toContain("example_crm");
    expect(plan.entries.map((e) => e.moduleKey)).toContain("example_loyalty");
    expect(plan.entries.map((e) => e.moduleKey)).toContain(
      "example_erp_extension"
    );
    expect(plan.orphanedModuleKeys).toEqual([]);
  });
});
