/**
 * Pure unit tests for reference_data's static module-contribution
 * registry validator (Issue #750, epic #738 platform-evolution Wave 3,
 * ADR-0021 §5) — same shape as `tests/unit/sod-rule-registry.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { validateReferenceDataContributionRegistry } from "../../src/modules/reference-data/domain/contribution-registry";
import { referenceDataModule } from "../../src/modules/reference-data/module";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";

function moduleWithContribution(
  key: string,
  overrides: Partial<
    NonNullable<
      ModuleDescriptor["referenceData"]
    >["contributesValueSets"][number]
  > = {}
): ModuleDescriptor {
  return {
    key,
    name: key,
    version: "0.1.0",
    status: "active",
    description: "test",
    dependencies: [],
    referenceData: {
      contributesValueSets: [
        {
          key: "test_value_set",
          name: "Test Value Set",
          description: "A test value set.",
          overridePolicy: "none",
          codes: [
            {
              code: "A",
              labels: [{ locale: "en", label: "A" }]
            }
          ],
          ...overrides
        }
      ]
    }
  };
}

describe("reference_data's own real seed contributions", () => {
  test("the real registry (reference_data module included) validates cleanly", () => {
    const result = validateReferenceDataContributionRegistry([
      referenceDataModule
    ]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contributions.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("validateReferenceDataContributionRegistry", () => {
  test("a well-formed single-module contribution is valid", () => {
    const result = validateReferenceDataContributionRegistry([
      moduleWithContribution("mod_a")
    ]);
    expect(result.valid).toBe(true);
  });

  test("rejects an invalid value-set key format", () => {
    const result = validateReferenceDataContributionRegistry([
      moduleWithContribution("mod_a", { key: "Not-Valid" })
    ]);
    expect(result.valid).toBe(false);
  });

  test("rejects an unknown overridePolicy", () => {
    const result = validateReferenceDataContributionRegistry([
      moduleWithContribution("mod_a", { overridePolicy: "whatever" as never })
    ]);
    expect(result.valid).toBe(false);
  });

  test("rejects a code missing an 'en' label", () => {
    const result = validateReferenceDataContributionRegistry([
      moduleWithContribution("mod_a", {
        codes: [{ code: "A", labels: [{ locale: "id", label: "A" }] }]
      })
    ]);
    expect(result.valid).toBe(false);
  });

  test("rejects two DIFFERENT modules declaring the SAME value-set key (exactly one owner allowed)", () => {
    const moduleA = moduleWithContribution("mod_a", { key: "shared_key" });
    const moduleB = moduleWithContribution("mod_b", { key: "shared_key" });
    const result = validateReferenceDataContributionRegistry([
      moduleA,
      moduleB
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some((issue) =>
          issue.message.includes("exactly one owner")
        )
      ).toBe(true);
    }
  });

  test("an empty registry (no module declares any contribution) is trivially valid", () => {
    const result = validateReferenceDataContributionRegistry([]);
    expect(result.valid).toBe(true);
  });
});
