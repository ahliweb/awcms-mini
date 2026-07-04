import { describe, expect, test } from "bun:test";
import { getModuleByKey, modules, validateModuleRegistry } from "../../src/modules/index";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";

describe("module registry (doc 10/11)", () => {
  test("registry base valid: descriptor, key unik, dependency dikenal", () => {
    expect(() => validateModuleRegistry()).not.toThrow();
    expect(modules.length).toBeGreaterThanOrEqual(11);
  });

  test("modul base wajib tersedia", () => {
    for (const key of [
      "tenant_admin",
      "identity_access",
      "profile_identity",
      "observability_logging",
      "database_connectivity",
      "workflow_approval",
      "management_reporting",
      "localization_ui",
      "ui_experience",
      "production_security_readiness",
      "sync_storage"
    ]) {
      expect(getModuleByKey(key)?.key).toBe(key);
    }
  });

  test("dependency tak dikenal terdeteksi", () => {
    const broken: ModuleDescriptor[] = [
      {
        key: "a_module",
        name: "A",
        version: "0.1.0",
        status: "active",
        description: "x",
        dependencies: ["tidak_ada"]
      }
    ];
    expect(() => validateModuleRegistry(broken)).toThrow(/tidak dikenal/);
  });

  test("key duplikat terdeteksi", () => {
    const dup: ModuleDescriptor[] = [
      { key: "a", name: "A", version: "1", status: "active", description: "x", dependencies: [] },
      { key: "a", name: "A2", version: "1", status: "active", description: "y", dependencies: [] }
    ];
    expect(() => validateModuleRegistry(dup)).toThrow(/duplikat/);
  });

  test("module key harus snake_case", () => {
    const bad: ModuleDescriptor[] = [
      {
        key: "Bad-Key",
        name: "B",
        version: "1",
        status: "active",
        description: "x",
        dependencies: []
      }
    ];
    expect(() => validateModuleRegistry(bad)).toThrow(/snake_case/);
  });
});
