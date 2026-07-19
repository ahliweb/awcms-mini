import { describe, expect, test } from "bun:test";

import type {
  ApplicationModuleRegistry,
  ModuleDescriptor
} from "../../src/modules/_shared/module-contract";
import type { ExtensionCompatibilityManifest } from "../../src/modules/_shared/extension-manifest-contract";
import {
  evaluateExtensionCompatibility,
  evaluateExtensionManifest,
  formatExtensionManifestIssue,
  parseExtensionManifest,
  type ExtensionCompatibilityFacts,
  type ExtensionManifestIssue
} from "../../src/modules/module-management/domain/extension-compatibility";

function manifest(
  overrides: Partial<ExtensionCompatibilityManifest> = {}
): ExtensionCompatibilityManifest {
  return {
    manifestVersion: "1.0.0",
    application: { key: "test-app", version: "0.1.0" },
    compatibleAwcmsMiniRange: ">=0.20.0 <1.0.0",
    moduleContractVersion: "1.0.0",
    contributedModules: [],
    migrations: {
      namespace: { label: "test", rangeStart: 900, rangeEnd: 999 },
      historicalChecksums: []
    },
    deployment: { requiredProfiles: [] },
    ...overrides
  };
}

function facts(
  overrides: Partial<ExtensionCompatibilityFacts> = {}
): ExtensionCompatibilityFacts {
  return {
    actualBaseVersion: "0.23.5",
    actualModuleContractVersion: "1.0.0",
    actualSaasContractVersion: "1.0.0",
    capabilityVersions: { public_content: "1.0.0" },
    migrationFiles: [],
    actualOpenApiContractVersion: "1.0.0",
    actualAsyncApiContractVersion: "1.0.0",
    ...overrides
  };
}

function issueTypes(issues: readonly ExtensionManifestIssue[]): string[] {
  return issues.map((i) => i.type);
}

describe("evaluateExtensionManifest — baseline (Issue #741)", () => {
  test("a fully valid manifest produces zero issues", () => {
    expect(evaluateExtensionManifest(manifest(), facts())).toEqual([]);
  });

  test("every issue type has a non-empty formatted message", () => {
    // Sanity: formatExtensionManifestIssue must handle every member of the
    // union without throwing — exercised properly per-case below, this is
    // a cheap exhaustiveness smoke test using one instance per type.
    const sample: ExtensionManifestIssue[] = [
      { type: "manifest_schema_invalid", path: "$", message: "x" },
      {
        type: "manifest_schema_version_unsupported",
        declaredVersion: "2.0.0",
        actualVersion: "1.0.0"
      },
      { type: "base_version_range_invalid", range: "garbage" },
      {
        type: "base_version_range_incompatible",
        declaredRange: ">=99.0.0",
        actualVersion: "0.23.5"
      },
      { type: "module_contract_version_invalid", declaredVersion: "x" },
      {
        type: "module_contract_version_unsupported",
        declaredVersion: "2.0.0",
        actualVersion: "1.0.0"
      },
      { type: "duplicate_contributed_module", moduleKey: "a", occurrences: 2 },
      { type: "capability_unknown", capability: "x", providedBy: "y" },
      {
        type: "capability_version_unsupported",
        capability: "x",
        declaredVersion: "2.0.0",
        actualVersion: "1.0.0",
        source: "base"
      },
      {
        type: "duplicate_migration_identifier",
        file: "900_a.sql",
        occurrences: 2
      },
      {
        type: "duplicate_migration_number",
        number: 900,
        files: ["a.sql", "b.sql"]
      },
      {
        type: "migration_checksum_changed",
        file: "900_a.sql",
        declaredChecksum: "sha256:a",
        actualChecksum: "sha256:b"
      },
      { type: "migration_history_missing_file", file: "900_a.sql" },
      {
        type: "migration_ordering_violation",
        file: "900_a.sql",
        number: 900,
        reason: "x"
      },
      {
        type: "deployment_profile_unsupported_by_module",
        moduleKey: "a",
        profile: "offline-lan"
      },
      {
        type: "stale_api_contract_assumption",
        contract: "openapi",
        declaredVersion: "2.0.0",
        actualVersion: "1.0.0",
        reason: "x"
      }
    ];

    for (const issue of sample) {
      expect(formatExtensionManifestIssue(issue).length).toBeGreaterThan(0);
    }
  });
});

describe("checkManifestSchemaVersion (Issue #741)", () => {
  test("major mismatch is unsupported", () => {
    const issues = evaluateExtensionManifest(
      manifest({ manifestVersion: "2.0.0" }),
      facts()
    );
    expect(issueTypes(issues)).toContain("manifest_schema_version_unsupported");
  });

  test("same major, any minor, is supported", () => {
    const issues = evaluateExtensionManifest(
      manifest({ manifestVersion: "1.0.0" }),
      facts()
    );
    expect(issueTypes(issues)).not.toContain(
      "manifest_schema_version_unsupported"
    );
  });
});

describe("checkBaseVersionRange (Issue #741)", () => {
  test("incompatible range fails with an actionable diagnostic", () => {
    const issues = evaluateExtensionManifest(
      manifest({ compatibleAwcmsMiniRange: ">=99.0.0 <100.0.0" }),
      facts({ actualBaseVersion: "0.23.5" })
    );
    expect(issueTypes(issues)).toContain("base_version_range_incompatible");
  });

  test("compatible range passes", () => {
    const issues = evaluateExtensionManifest(
      manifest({ compatibleAwcmsMiniRange: ">=0.20.0 <1.0.0" }),
      facts({ actualBaseVersion: "0.23.5" })
    );
    expect(issueTypes(issues)).not.toContain("base_version_range_incompatible");
  });

  test("a malformed range string is its own distinct diagnostic, not silently 'incompatible'", () => {
    const issues = evaluateExtensionManifest(
      manifest({ compatibleAwcmsMiniRange: "not a range at all" }),
      facts()
    );
    expect(issueTypes(issues)).toContain("base_version_range_invalid");
    expect(issueTypes(issues)).not.toContain("base_version_range_incompatible");
  });
});

describe("checkModuleContractVersion (Issue #741)", () => {
  test("major mismatch is unsupported", () => {
    const issues = evaluateExtensionManifest(
      manifest({ moduleContractVersion: "2.0.0" }),
      facts({ actualModuleContractVersion: "1.0.0" })
    );
    expect(issueTypes(issues)).toContain("module_contract_version_unsupported");
  });

  test("declared minor greater than actual minor is unsupported (assumes a feature that doesn't exist yet)", () => {
    const issues = evaluateExtensionManifest(
      manifest({ moduleContractVersion: "1.5.0" }),
      facts({ actualModuleContractVersion: "1.0.0" })
    );
    expect(issueTypes(issues)).toContain("module_contract_version_unsupported");
  });

  test("declared minor less than or equal to actual minor is supported", () => {
    const issues = evaluateExtensionManifest(
      manifest({ moduleContractVersion: "1.0.0" }),
      facts({ actualModuleContractVersion: "1.5.0" })
    );
    expect(issueTypes(issues)).not.toContain(
      "module_contract_version_unsupported"
    );
  });

  test("an invalid version string is its own distinct diagnostic", () => {
    const issues = evaluateExtensionManifest(
      manifest({ moduleContractVersion: "not-semver" }),
      facts()
    );
    expect(issueTypes(issues)).toContain("module_contract_version_invalid");
  });
});

describe("checkSaasContractVersion (Issue #874)", () => {
  test("absent saasContractVersion is not a failure", () => {
    const issues = evaluateExtensionManifest(
      manifest({ saasContractVersion: undefined }),
      facts({ actualSaasContractVersion: "1.0.0" })
    );
    expect(issueTypes(issues)).not.toContain(
      "saas_contract_version_unsupported"
    );
    expect(issueTypes(issues)).not.toContain("saas_contract_version_invalid");
  });

  test("major mismatch is unsupported", () => {
    const issues = evaluateExtensionManifest(
      manifest({ saasContractVersion: "2.0.0" }),
      facts({ actualSaasContractVersion: "1.0.0" })
    );
    expect(issueTypes(issues)).toContain("saas_contract_version_unsupported");
  });

  test("declared minor greater than actual minor is unsupported", () => {
    const issues = evaluateExtensionManifest(
      manifest({ saasContractVersion: "1.5.0" }),
      facts({ actualSaasContractVersion: "1.0.0" })
    );
    expect(issueTypes(issues)).toContain("saas_contract_version_unsupported");
  });

  test("declared minor <= actual minor is supported", () => {
    const issues = evaluateExtensionManifest(
      manifest({ saasContractVersion: "1.0.0" }),
      facts({ actualSaasContractVersion: "1.5.0" })
    );
    expect(issueTypes(issues)).not.toContain(
      "saas_contract_version_unsupported"
    );
  });

  test("an invalid version string is its own distinct diagnostic", () => {
    const issues = evaluateExtensionManifest(
      manifest({ saasContractVersion: "not-semver" }),
      facts()
    );
    expect(issueTypes(issues)).toContain("saas_contract_version_invalid");
  });
});

describe("checkDuplicateContributedModules (Issue #741)", () => {
  test("a repeated module key fails", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        contributedModules: [{ key: "sales" }, { key: "sales" }]
      }),
      facts()
    );
    expect(issueTypes(issues)).toContain("duplicate_contributed_module");
  });

  test("distinct module keys pass", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        contributedModules: [{ key: "sales" }, { key: "inventory" }]
      }),
      facts()
    );
    expect(issueTypes(issues)).not.toContain("duplicate_contributed_module");
  });
});

describe("checkCapabilities (Issue #741)", () => {
  test("unknown capability (neither base-known nor self-provided) fails", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        capabilities: {
          requires: [{ key: "nope", providedBy: "nowhere", version: "1.0.0" }]
        }
      }),
      facts()
    );
    expect(issueTypes(issues)).toContain("capability_unknown");
  });

  test("version mismatch against a known BASE capability fails", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        capabilities: {
          requires: [
            {
              key: "public_content",
              providedBy: "blog_content",
              version: "9.0.0"
            }
          ]
        }
      }),
      facts({ capabilityVersions: { public_content: "1.0.0" } })
    );
    expect(issueTypes(issues)).toContain("capability_version_unsupported");
  });

  test("version mismatch is still checked for an optional: true requirement (deliberate, see code comment)", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        capabilities: {
          requires: [
            {
              key: "public_content",
              providedBy: "blog_content",
              version: "9.0.0",
              optional: true
            }
          ]
        }
      }),
      facts({ capabilityVersions: { public_content: "1.0.0" } })
    );
    expect(issueTypes(issues)).toContain("capability_version_unsupported");
  });

  test("a capability resolved via the manifest's OWN self-declared 'provides' (not the base registry) is checked against that self-declared version", () => {
    const compatible = evaluateExtensionManifest(
      manifest({
        capabilities: {
          provides: [{ key: "example_loyalty_ledger", version: "1.0.0" }],
          requires: [
            {
              key: "example_loyalty_ledger",
              providedBy: "example_loyalty",
              version: "1.0.0"
            }
          ]
        }
      }),
      facts({ capabilityVersions: {} })
    );
    expect(issueTypes(compatible)).not.toContain("capability_unknown");
    expect(issueTypes(compatible)).not.toContain(
      "capability_version_unsupported"
    );

    const incompatible = evaluateExtensionManifest(
      manifest({
        capabilities: {
          provides: [{ key: "example_loyalty_ledger", version: "1.0.0" }],
          requires: [
            {
              key: "example_loyalty_ledger",
              providedBy: "example_loyalty",
              version: "9.0.0"
            }
          ]
        }
      }),
      facts({ capabilityVersions: {} })
    );
    expect(issueTypes(incompatible)).toContain(
      "capability_version_unsupported"
    );
  });

  test("a known, compatible base capability produces no issue", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        capabilities: {
          requires: [
            {
              key: "public_content",
              providedBy: "blog_content",
              version: "1.0.0"
            }
          ]
        }
      }),
      facts({ capabilityVersions: { public_content: "1.0.0" } })
    );
    expect(issues).toEqual([]);
  });
});

describe("checkMigrations (Issue #741)", () => {
  test("duplicate historicalChecksums file entry fails", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [
            { file: "900_a.sql", checksum: "sha256:a" },
            { file: "900_a.sql", checksum: "sha256:a" }
          ]
        }
      }),
      facts()
    );
    expect(issueTypes(issues)).toContain("duplicate_migration_identifier");
  });

  test("two distinct filenames sharing the same leading numeric prefix fails", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [
            { file: "900_a.sql", checksum: "sha256:a" },
            { file: "900_b.sql", checksum: "sha256:b" }
          ]
        }
      }),
      facts({
        migrationFiles: [
          { name: "900_a.sql", checksum: "sha256:a" },
          { name: "900_b.sql", checksum: "sha256:b" }
        ]
      })
    );
    expect(issueTypes(issues)).toContain("duplicate_migration_number");
  });

  test("a historical entry numbered outside the declared namespace range fails", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [{ file: "500_a.sql", checksum: "sha256:a" }]
        }
      }),
      facts({ migrationFiles: [{ name: "500_a.sql", checksum: "sha256:a" }] })
    );
    expect(issueTypes(issues)).toContain("migration_ordering_violation");
  });

  test("checksum mismatch against the real on-disk file fails (immutability)", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [
            { file: "900_a.sql", checksum: "sha256:declared" }
          ]
        }
      }),
      facts({
        migrationFiles: [{ name: "900_a.sql", checksum: "sha256:actual" }]
      })
    );
    expect(issueTypes(issues)).toContain("migration_checksum_changed");
  });

  test("a historical file missing from disk fails distinctly from a checksum change", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [
            { file: "900_a.sql", checksum: "sha256:declared" }
          ]
        }
      }),
      facts({ migrationFiles: [] })
    );
    expect(issueTypes(issues)).toContain("migration_history_missing_file");
    expect(issueTypes(issues)).not.toContain("migration_checksum_changed");
  });

  test("matching checksum on disk produces no issue", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [{ file: "900_a.sql", checksum: "sha256:same" }]
        }
      }),
      facts({
        migrationFiles: [{ name: "900_a.sql", checksum: "sha256:same" }]
      })
    );
    expect(issues).toEqual([]);
  });

  test("a NEW (non-historical) file numbered at or before the historical high-water mark fails — can't insert before a shipped migration", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [{ file: "905_a.sql", checksum: "sha256:a" }]
        }
      }),
      facts({
        migrationFiles: [
          { name: "905_a.sql", checksum: "sha256:a" },
          { name: "902_b.sql", checksum: "sha256:b" } // inserted "before" 905, never declared historical
        ]
      })
    );
    expect(issueTypes(issues)).toContain("migration_ordering_violation");
  });

  test("a NEW file numbered after the historical high-water mark is fine (normal forward progress)", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        migrations: {
          namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
          historicalChecksums: [{ file: "905_a.sql", checksum: "sha256:a" }]
        }
      }),
      facts({
        migrationFiles: [
          { name: "905_a.sql", checksum: "sha256:a" },
          { name: "910_b.sql", checksum: "sha256:b" }
        ]
      })
    );
    expect(issueTypes(issues)).toEqual([]);
  });

  test("empty historicalChecksums is valid (a derived app that has never shipped a migration yet)", () => {
    expect(
      evaluateExtensionManifest(
        manifest({
          migrations: {
            namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
            historicalChecksums: []
          }
        }),
        facts({ migrationFiles: [{ name: "900_a.sql", checksum: "sha256:a" }] })
      )
    ).toEqual([]);
  });
});

describe("checkDeploymentProfiles (Issue #741)", () => {
  test("a contributed module's narrower self-declared profiles fails against a broader requirement", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        contributedModules: [
          { key: "sales", deploymentProfiles: ["production"] }
        ],
        deployment: { requiredProfiles: ["offline-lan"] }
      }),
      facts()
    );
    expect(issueTypes(issues)).toContain(
      "deployment_profile_unsupported_by_module"
    );
  });

  test("a module with no self-declared deploymentProfiles is never checked (absence = no constraint)", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        contributedModules: [{ key: "sales" }],
        deployment: { requiredProfiles: ["offline-lan"] }
      }),
      facts()
    );
    expect(issueTypes(issues)).not.toContain(
      "deployment_profile_unsupported_by_module"
    );
  });

  test("a module whose declared profiles are a superset of the requirement passes", () => {
    const issues = evaluateExtensionManifest(
      manifest({
        contributedModules: [
          {
            key: "sales",
            deploymentProfiles: ["development", "offline-lan", "production"]
          }
        ],
        deployment: { requiredProfiles: ["offline-lan"] }
      }),
      facts()
    );
    expect(issueTypes(issues)).not.toContain(
      "deployment_profile_unsupported_by_module"
    );
  });
});

describe("checkContractStaleness (Issue #741)", () => {
  test("major mismatch on the OpenAPI contract version fails", () => {
    const issues = evaluateExtensionManifest(
      manifest({ consumes: { openApiContractVersion: "5.0.0" } }),
      facts({ actualOpenApiContractVersion: "1.0.0" })
    );
    expect(issueTypes(issues)).toContain("stale_api_contract_assumption");
  });

  test("major mismatch on the AsyncAPI contract version fails, reported distinctly from OpenAPI", () => {
    const issues = evaluateExtensionManifest(
      manifest({ consumes: { asyncApiContractVersion: "5.0.0" } }),
      facts({ actualAsyncApiContractVersion: "1.0.0" })
    );
    const staleIssues = issues.filter(
      (
        i
      ): i is Extract<
        ExtensionManifestIssue,
        { type: "stale_api_contract_assumption" }
      > => i.type === "stale_api_contract_assumption"
    );
    expect(staleIssues).toHaveLength(1);
    expect(staleIssues[0]?.contract).toBe("asyncapi");
  });

  test("declared minor greater than actual minor fails (assumes an unreleased feature)", () => {
    const issues = evaluateExtensionManifest(
      manifest({ consumes: { openApiContractVersion: "1.5.0" } }),
      facts({ actualOpenApiContractVersion: "1.0.0" })
    );
    expect(issueTypes(issues)).toContain("stale_api_contract_assumption");
  });

  test("same major, declared minor/patch <= actual is fine", () => {
    const issues = evaluateExtensionManifest(
      manifest({ consumes: { openApiContractVersion: "1.0.0" } }),
      facts({ actualOpenApiContractVersion: "1.4.0" })
    );
    expect(issueTypes(issues)).not.toContain("stale_api_contract_assumption");
  });

  test("consumes omitted entirely is never checked", () => {
    const issues = evaluateExtensionManifest(
      manifest({ consumes: undefined }),
      facts()
    );
    expect(issueTypes(issues)).not.toContain("stale_api_contract_assumption");
  });
});

describe("parseExtensionManifest — schema-bounded structural validation (Issue #741)", () => {
  test("a fully valid manifest parses successfully", () => {
    const result = parseExtensionManifest(manifest());
    expect(result.valid).toBe(true);
  });

  test("non-object input fails with a single schema issue, never throws", () => {
    const result = parseExtensionManifest("just a string");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.type).toBe("manifest_schema_invalid");
    }
  });

  test("null input fails gracefully", () => {
    const result = parseExtensionManifest(null);
    expect(result.valid).toBe(false);
  });

  test("collects every structural problem in one pass, not just the first", () => {
    const result = parseExtensionManifest({
      manifestVersion: 123, // wrong type
      application: { key: "a" }, // missing version
      compatibleAwcmsMiniRange: ">=1.0.0",
      moduleContractVersion: "1.0.0",
      contributedModules: "not-an-array", // wrong type
      migrations: {
        namespace: { label: "t", rangeStart: 900, rangeEnd: 999 },
        historicalChecksums: []
      },
      deployment: { requiredProfiles: [] }
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("no manifest value is ever evaluated as code — a string containing script-like content is treated as inert data", () => {
    const result = parseExtensionManifest(
      manifest({
        application: { key: "'; DROP TABLE x; --", version: "0.1.0" }
      })
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.application.key).toBe("'; DROP TABLE x; --");
    }
  });
});

describe("evaluateExtensionCompatibility — combined report (Issue #741)", () => {
  const baseModules: ModuleDescriptor[] = [
    {
      key: "tenant_admin",
      name: "Tenant Admin",
      version: "1.0.0",
      status: "active",
      description: "base",
      dependencies: []
    }
  ];

  test("no manifest: only module composition is checked, manifestChecked is false", () => {
    const report = evaluateExtensionCompatibility({
      base: baseModules,
      application: undefined,
      manifest: undefined,
      facts: facts()
    });
    expect(report.manifestChecked).toBe(false);
    expect(report.manifestIssues).toEqual([]);
    expect(report.valid).toBe(true);
  });

  test("a manifest with issues makes the combined report invalid, alongside a valid composed registry", () => {
    const report = evaluateExtensionCompatibility({
      base: baseModules,
      application: undefined,
      manifest: manifest({ compatibleAwcmsMiniRange: ">=99.0.0" }),
      facts: facts({ actualBaseVersion: "0.23.5" })
    });
    expect(report.manifestChecked).toBe(true);
    expect(report.valid).toBe(false);
    expect(report.moduleCompositionIssues).toEqual([]);
    expect(issueTypes(report.manifestIssues)).toContain(
      "base_version_range_incompatible"
    );
  });

  test("an application module colliding with a base module key fails via the REUSED module-composition engine, not duplicated logic here", () => {
    const application: ApplicationModuleRegistry = {
      id: "test",
      modules: [
        {
          key: "tenant_admin", // collides with the base module above
          name: "Evil",
          version: "0.1.0",
          status: "experimental",
          description: "collides",
          dependencies: []
        }
      ]
    };

    const report = evaluateExtensionCompatibility({
      base: baseModules,
      application,
      manifest: undefined,
      facts: facts()
    });
    expect(report.valid).toBe(false);
    expect(
      report.moduleCompositionIssues.some(
        (i) => i.type === "prohibited_base_override"
      )
    ).toBe(true);
  });
});
