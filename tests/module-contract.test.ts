import { describe, expect, test } from "bun:test";

import { defineModule } from "../src/modules/_shared/module-contract";

describe("defineModule — backward compatibility (Issue #511)", () => {
  test("a descriptor with only the original fields remains valid", () => {
    const descriptor = defineModule({
      key: "example",
      name: "Example",
      version: "1.0.0",
      status: "active",
      description: "Minimal descriptor using only pre-Issue-#511 fields.",
      dependencies: []
    });

    expect(descriptor.key).toBe("example");
    expect(descriptor.type).toBeUndefined();
    expect(descriptor.permissions).toBeUndefined();
  });

  test("the existing three lifecycle statuses still type-check", () => {
    for (const status of ["active", "experimental", "deprecated"] as const) {
      const descriptor = defineModule({
        key: "example",
        name: "Example",
        version: "1.0.0",
        status,
        description: "Status compatibility check.",
        dependencies: []
      });

      expect(descriptor.status).toBe(status);
    }
  });
});

describe("defineModule — new optional metadata (Issue #511)", () => {
  test("the two new lifecycle statuses (maintenance, disabled) are accepted", () => {
    for (const status of ["maintenance", "disabled"] as const) {
      const descriptor = defineModule({
        key: "example",
        name: "Example",
        version: "1.0.0",
        status,
        description: "New lifecycle status.",
        dependencies: []
      });

      expect(descriptor.status).toBe(status);
    }
  });

  test("a fully-populated module_management-shaped descriptor is constructible", () => {
    const descriptor = defineModule({
      key: "module_management",
      name: "Module Management",
      version: "0.1.0",
      status: "active",
      description:
        "Database-backed, tenant-aware module registry, lifecycle, settings, navigation, jobs, and health (epic #510).",
      dependencies: ["tenant_admin", "identity_access"],
      type: "system",
      isCore: true,
      permissions: [
        {
          activityCode: "modules",
          action: "read",
          description: "Read the module registry"
        },
        {
          activityCode: "modules",
          action: "sync",
          description: "Sync trusted descriptors into the database registry"
        }
      ],
      navigation: [
        {
          labelKey: "admin.layout.nav_modules",
          path: "/admin/modules",
          order: 100,
          requiredPermission: "module_management.modules.read"
        }
      ],
      settings: {
        schemaVersion: 1,
        defaults: { autoSyncOnBoot: false }
      },
      jobs: [
        {
          command: "bun run modules:sync",
          purpose: "Sync trusted code descriptors into the database registry.",
          recommendedSchedule: "on deploy",
          safeInOfflineLan: true
        }
      ],
      health: { hasHealthCheck: true, hasReadinessCheck: true },
      compatibility: { minAppVersion: "0.23.0" },
      maintainers: ["platform-team"]
    });

    expect(descriptor.type).toBe("system");
    expect(descriptor.isCore).toBe(true);
    expect(descriptor.permissions).toHaveLength(2);
    expect(descriptor.navigation?.[0]?.path).toBe("/admin/modules");
    expect(descriptor.settings?.defaults).toEqual({ autoSyncOnBoot: false });
    expect(descriptor.jobs?.[0]?.command).toBe("bun run modules:sync");
    expect(descriptor.health).toEqual({
      hasHealthCheck: true,
      hasReadinessCheck: true
    });
    expect(descriptor.compatibility?.minAppVersion).toBe("0.23.0");
    expect(descriptor.maintainers).toEqual(["platform-team"]);
  });

  test("descriptor metadata never needs a secret-shaped field to be useful", () => {
    // Documents the security note as an executable check: none of the new
    // optional fields require (or even accept a natural place for) a
    // runtime secret — settings.defaults is the only free-form bag, and it
    // is documented as non-secret-only (Issue #511/#516).
    const descriptor = defineModule({
      key: "module_management",
      name: "Module Management",
      version: "0.1.0",
      status: "active",
      description: "Secret-free descriptor check.",
      dependencies: [],
      settings: { defaults: { autoSyncOnBoot: false } }
    });

    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
  });
});
