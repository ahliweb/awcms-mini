/**
 * Unit tests for the high-volume table registry validation gate (Issue
 * #745). Pure code — no database, no I/O — same as the domain module
 * itself. Also asserts the REAL registry (every module currently
 * registered in `listModules()`) validates cleanly, which is exactly
 * what `bun run data-lifecycle:registry:check` and
 * `security:readiness`'s `checkDataLifecycleRegistryValid` both check —
 * a regression here means those two would also start failing.
 */
import { describe, expect, test } from "bun:test";

import type {
  HighVolumeTableDescriptor,
  ModuleDescriptor
} from "../../src/modules/_shared/module-contract";
import { listModules } from "../../src/modules";
import {
  collectHighVolumeTableDescriptors,
  formatLifecycleRegistryIssue,
  validateLifecycleRegistry
} from "../../src/modules/data-lifecycle/domain/lifecycle-registry";

function buildDescriptor(
  overrides: Partial<HighVolumeTableDescriptor> = {}
): HighVolumeTableDescriptor {
  return {
    key: "test_module.widgets",
    tableName: "awcms_mini_widgets",
    ownerModuleKey: "test_module",
    scope: "tenant",
    cursorColumn: "created_at",
    retentionClass: "operational_queue",
    retentionMinDays: 1,
    retentionMaxDays: 365,
    defaultRetentionDays: 30,
    partition: { eligible: false, rationale: "Low volume." },
    archive: { archivable: false, rationale: "No archive step." },
    deletion: { mode: "hard_delete", rationale: "Plain delete." },
    legalHold: { applicable: true, precedence: "overrides_retention" },
    requiredIndexes: [
      { columns: ["tenant_id", "created_at"], purpose: "Batching." }
    ],
    batchLimit: 1000,
    backupRestoreNotes: "Included in ordinary backup.",
    executionMode: "generic",
    ...overrides
  };
}

function moduleWith(
  descriptors: HighVolumeTableDescriptor[],
  key = "test_module"
): ModuleDescriptor {
  return {
    key,
    name: "Test Module",
    version: "1.0.0",
    status: "active",
    description: "Fixture module.",
    dependencies: [],
    dataLifecycle: descriptors
  };
}

describe("validateLifecycleRegistry", () => {
  test("a well-formed generic-mode descriptor passes", () => {
    const result = validateLifecycleRegistry([moduleWith([buildDescriptor()])]);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.descriptors).toHaveLength(1);
  });

  test("a well-formed delegated-mode descriptor passes", () => {
    const descriptor = buildDescriptor({
      executionMode: "delegated",
      existingAdopter: {
        purgeFunctionRef:
          "src/modules/test_module/application/purge.ts#purgeWidgets",
        description: "Existing purge mechanism."
      },
      requiredIndexes: [
        { columns: ["tenant_id"], purpose: "Dry-run count scoping." }
      ]
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(true);
  });

  test("rejects ownerModuleKey that doesn't match the declaring module's own key", () => {
    const descriptor = buildDescriptor({ ownerModuleKey: "someone_else" });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.message.includes("ownerModuleKey"))
    ).toBe(true);
  });

  test("rejects a tableName not prefixed awcms_mini_", () => {
    const descriptor = buildDescriptor({ tableName: "widgets" });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.message.includes("tableName"))
    ).toBe(true);
  });

  test("rejects retentionMinDays > defaultRetentionDays > retentionMaxDays violations", () => {
    const descriptor = buildDescriptor({
      retentionMinDays: 100,
      defaultRetentionDays: 30,
      retentionMaxDays: 365
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.message.includes("retention bounds"))
    ).toBe(true);
  });

  test("rejects partition.eligible=true without a granularity", () => {
    const descriptor = buildDescriptor({
      partition: { eligible: true, rationale: "High volume." }
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.message.includes("partition.granularity")
      )
    ).toBe(true);
  });

  test("rejects archive.archivable=true without format/port", () => {
    const descriptor = buildDescriptor({
      archive: { archivable: true, rationale: "Should archive." }
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.message.includes("archive.format"))
    ).toBe(true);
    expect(
      result.issues.some((issue) => issue.message.includes("archive.port"))
    ).toBe(true);
  });

  test("rejects legalHold.applicable=true with precedence not_applicable — the invariant cannot be declared away", () => {
    const descriptor = buildDescriptor({
      legalHold: { applicable: true, precedence: "not_applicable" }
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.message.includes("overrides_retention")
      )
    ).toBe(true);
  });

  test("rejects legalHold.applicable=false with precedence overrides_retention", () => {
    const descriptor = buildDescriptor({
      legalHold: { applicable: false, precedence: "overrides_retention" }
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.message.includes('"not_applicable"'))
    ).toBe(true);
  });

  test("generic mode requires an index covering BOTH tenant and cursor columns", () => {
    const descriptor = buildDescriptor({
      executionMode: "generic",
      requiredIndexes: [{ columns: ["tenant_id"], purpose: "Tenant only." }]
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.message.includes("tenant column") &&
          issue.message.includes("cursor column")
      )
    ).toBe(true);
  });

  test("delegated mode does NOT require the strict tenant+cursor composite index — the real query is owned elsewhere", () => {
    const descriptor = buildDescriptor({
      executionMode: "delegated",
      requiredIndexes: [{ columns: ["tenant_id"], purpose: "Tenant only." }],
      existingAdopter: {
        purgeFunctionRef:
          "src/modules/test_module/application/purge.ts#purgeWidgets",
        description: "Existing mechanism."
      }
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(true);
  });

  test("rejects batchLimit <= 0 or above the safety ceiling", () => {
    const zero = validateLifecycleRegistry([
      moduleWith([buildDescriptor({ batchLimit: 0 })])
    ]);
    expect(zero.valid).toBe(false);

    const tooLarge = validateLifecycleRegistry([
      moduleWith([buildDescriptor({ batchLimit: 10_000_000 })])
    ]);
    expect(tooLarge.valid).toBe(false);
  });

  test('executionMode "delegated" without existingAdopter fails', () => {
    const descriptor = buildDescriptor({
      executionMode: "delegated",
      existingAdopter: undefined
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.message.includes("existingAdopter"))
    ).toBe(true);
  });

  test('executionMode "generic" WITH existingAdopter also fails — a table cannot both delegate and be generic', () => {
    const descriptor = buildDescriptor({
      executionMode: "generic",
      existingAdopter: {
        purgeFunctionRef:
          "src/modules/test_module/application/purge.ts#purgeWidgets",
        description: "Should not be present."
      }
    });
    const result = validateLifecycleRegistry([moduleWith([descriptor])]);

    expect(result.valid).toBe(false);
  });

  test("rejects a duplicate descriptor key across two modules", () => {
    const descriptorA = buildDescriptor({
      key: "dup.key",
      ownerModuleKey: "module_a"
    });
    const descriptorB = buildDescriptor({
      key: "dup.key",
      tableName: "awcms_mini_other_table",
      ownerModuleKey: "module_b"
    });
    const result = validateLifecycleRegistry([
      moduleWith([descriptorA], "module_a"),
      moduleWith([descriptorB], "module_b")
    ]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.message.includes("registered 2 times")
      )
    ).toBe(true);
  });

  test("rejects a duplicate tableName across two modules (even with different keys)", () => {
    const descriptorA = buildDescriptor({
      key: "module_a.shared",
      ownerModuleKey: "module_a"
    });
    const descriptorB = buildDescriptor({
      key: "module_b.shared",
      ownerModuleKey: "module_b"
    });
    const result = validateLifecycleRegistry([
      moduleWith([descriptorA], "module_a"),
      moduleWith([descriptorB], "module_b")
    ]);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.message.includes("awcms_mini_widgets")
      )
    ).toBe(true);
  });

  test("a module with no dataLifecycle field at all contributes nothing (backward compatible)", () => {
    const module: ModuleDescriptor = {
      key: "no_lifecycle_module",
      name: "No Lifecycle",
      version: "1.0.0",
      status: "active",
      description: "Fixture.",
      dependencies: []
    };
    const result = validateLifecycleRegistry([module]);

    expect(result.valid).toBe(true);
    expect(result.descriptors).toEqual([]);
  });

  test("collectHighVolumeTableDescriptors flattens every module's own array, in module order", () => {
    const descriptorA = buildDescriptor({
      key: "module_a.one",
      ownerModuleKey: "module_a"
    });
    const descriptorB = buildDescriptor({
      key: "module_b.two",
      tableName: "awcms_mini_other",
      ownerModuleKey: "module_b"
    });
    const descriptors = collectHighVolumeTableDescriptors([
      moduleWith([descriptorA], "module_a"),
      moduleWith([descriptorB], "module_b")
    ]);

    expect(descriptors.map((descriptor) => descriptor.key)).toEqual([
      "module_a.one",
      "module_b.two"
    ]);
  });

  test("formatLifecycleRegistryIssue produces a readable one-line string", () => {
    const formatted = formatLifecycleRegistryIssue({
      descriptorKey: "some.key",
      message: "something is wrong"
    });

    expect(formatted).toBe("[some.key] something is wrong");
  });

  test("the REAL registered registry (listModules()) validates cleanly — regression guard for the actual descriptors this issue registers", () => {
    const result = validateLifecycleRegistry(listModules());

    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    // audit_events, visit_events, form_drafts (delegated) + data_lifecycle's
    // own run history (generic) — see module.ts files' own dataLifecycle
    // arrays.
    expect(result.descriptors.length).toBeGreaterThanOrEqual(4);
  });
});
