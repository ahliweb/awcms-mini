/**
 * Unit tests for the module-contributed SLO/alert registry (Issue #930, epic
 * #868).
 *
 * The validator's job is to make bad objectives IMPOSSIBLE to land, so every
 * test here is a mutation: take a valid descriptor, break exactly one thing,
 * and assert the gate rejects it. A test that only asserted "the real
 * registry is valid" would stay green against a validator that returned
 * `{ valid: true }` unconditionally — which is precisely the failure mode
 * this repo has hit before with a registry gate fed an incomplete graph.
 */
import { describe, expect, test } from "bun:test";

import { listModules } from "../../src/modules";
import { METRIC_DEFINITIONS } from "../../src/lib/observability/metrics-port";
import type {
  ModuleDescriptor,
  ServiceLevelObjectiveDescriptor
} from "../../src/modules/_shared/module-contract";
import {
  collectSloDescriptors,
  runbookFilePath,
  validateRunbookPathShape,
  validateSloRegistry
} from "../../src/modules/logging/domain/slo-registry";

/** A minimal, valid descriptor each test mutates one field of. */
function validDescriptor(): ServiceLevelObjectiveDescriptor {
  return {
    key: "reporting.example_objective",
    ownerModuleKey: "reporting",
    title: "Example objective",
    description:
      "A deliberately valid descriptor that each mutation test breaks in exactly one place.",
    kind: "backlog",
    metricName: "control_plane_projection_stale_total",
    dimension: "freshnessState",
    unit: "count",
    objectiveValue: 0,
    objectiveComparison: "above",
    runbookPath:
      "docs/awcms-mini/control-plane-slo-runbook.md#reporting-projection-freshness",
    thresholds: [
      {
        thresholdKey: "example_warning",
        severity: "warning",
        comparison: "above",
        value: 0,
        forSeconds: 900,
        operatorAction: "Run the projection refresh and check its grants."
      }
    ]
  };
}

/** Wraps descriptors in a fake module registry so the validator sees a real owner key. */
function registryWith(
  ...descriptors: ServiceLevelObjectiveDescriptor[]
): ModuleDescriptor[] {
  return [
    {
      key: "reporting",
      name: "Reporting",
      version: "1.0.0",
      status: "active",
      description: "Test stand-in for the reporting module.",
      serviceLevelObjectives: descriptors
    } as ModuleDescriptor
  ];
}

function issuesFor(descriptor: ServiceLevelObjectiveDescriptor): string[] {
  return validateSloRegistry(registryWith(descriptor)).issues.map(
    (issue) => issue.message
  );
}

describe("SLO registry validator (Issue #930)", () => {
  test("the baseline descriptor every mutation starts from is itself valid", () => {
    // Guards the whole file: if this were invalid, every mutation test below
    // would pass for the wrong reason.
    const result = validateSloRegistry(registryWith(validDescriptor()));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  describe("the two rules that keep alert dimensions low-cardinality", () => {
    test("rejects a metricName that is not declared in METRIC_DEFINITIONS", () => {
      // An objective evaluated against a metric nothing emits is permanently
      // silent: it looks like coverage and pages nobody.
      const issues = issuesFor({
        ...validDescriptor(),
        metricName: "control_plane_metric_that_nothing_emits",
        dimension: undefined
      });
      expect(issues.join("\n")).toContain(
        "is not declared in METRIC_DEFINITIONS"
      );
    });

    test("rejects a dimension the named metric does not declare as an allowed label", () => {
      // This is the structural reason an alert can never carry a tenant id:
      // the metric registry already bounded the label set.
      const issues = issuesFor({
        ...validDescriptor(),
        dimension: "tenantId"
      });
      expect(issues.join("\n")).toContain("allowedLabelKeys");
    });

    test("every dimension used by the REAL registry is an allowed label of its own metric", () => {
      // The property the previous test proves is enforced, asserted against
      // production descriptors rather than a fixture.
      for (const descriptor of collectSloDescriptors(listModules())) {
        if (descriptor.dimension === undefined) continue;
        const metric = (
          METRIC_DEFINITIONS as Record<
            string,
            { allowedLabelKeys: readonly string[] } | undefined
          >
        )[descriptor.metricName];
        expect(
          `${descriptor.key}:${metric?.allowedLabelKeys.includes(descriptor.dimension)}`
        ).toBe(`${descriptor.key}:true`);
      }
    });
  });

  describe("threshold coherence", () => {
    test("rejects a critical threshold less severe than the warning one", () => {
      // Inverted severities page the operator critical before warning — an
      // easily missed authoring bug with real on-call cost.
      const base = validDescriptor();
      const issues = issuesFor({
        ...base,
        thresholds: [
          {
            ...base.thresholds[0]!,
            thresholdKey: "warn",
            severity: "warning",
            value: 100
          },
          {
            ...base.thresholds[0]!,
            thresholdKey: "crit",
            severity: "critical",
            value: 10
          }
        ]
      });
      expect(issues.join("\n")).toContain(
        "less severe than the warning threshold"
      );
    });

    test("accepts a critical threshold further past an 'above' objective", () => {
      const base = validDescriptor();
      const issues = issuesFor({
        ...base,
        thresholds: [
          {
            ...base.thresholds[0]!,
            thresholdKey: "warn",
            severity: "warning",
            value: 10
          },
          {
            ...base.thresholds[0]!,
            thresholdKey: "crit",
            severity: "critical",
            value: 100
          }
        ]
      });
      expect(issues).toEqual([]);
    });

    test("severity ordering inverts correctly for a 'below' objective", () => {
      // For a success-rate objective, LOWER is worse — so a critical
      // threshold below the warning one is correct, and the reverse is not.
      const base = validDescriptor();
      const belowObjective: ServiceLevelObjectiveDescriptor = {
        ...base,
        metricName: "control_plane_provisioning_oldest_pending_seconds",
        dimension: undefined,
        unit: "ratio",
        objectiveValue: 0.99,
        objectiveComparison: "below",
        thresholds: [
          {
            ...base.thresholds[0]!,
            thresholdKey: "warn",
            severity: "warning",
            comparison: "below",
            value: 0.99
          },
          {
            ...base.thresholds[0]!,
            thresholdKey: "crit",
            severity: "critical",
            comparison: "below",
            value: 0.9
          }
        ]
      };
      expect(issuesFor(belowObjective)).toEqual([]);

      // Same numbers swapped between severities must now be rejected.
      const inverted = issuesFor({
        ...belowObjective,
        thresholds: [
          { ...belowObjective.thresholds[0]!, value: 0.9 },
          { ...belowObjective.thresholds[1]!, value: 0.99 }
        ]
      });
      expect(inverted.join("\n")).toContain(
        "less severe than the warning threshold"
      );
    });

    test("rejects a threshold pointing the opposite way from its objective", () => {
      // A "below 0" threshold on an "above 0" objective describes the HEALTHY
      // state, so it would fire permanently.
      const base = validDescriptor();
      const issues = issuesFor({
        ...base,
        thresholds: [{ ...base.thresholds[0]!, comparison: "below" }]
      });
      expect(issues.join("\n")).toContain("contradicts objectiveComparison");
    });

    test("rejects a 'below' threshold on a counter metric, which could never recover", () => {
      const base = validDescriptor();
      const issues = issuesFor({
        ...base,
        metricName: "business_scope_expirations_total",
        dimension: undefined,
        objectiveComparison: "below",
        thresholds: [{ ...base.thresholds[0]!, comparison: "below" }]
      });
      expect(issues.join("\n")).toContain("latch forever");
    });

    test("rejects an objective with no thresholds at all", () => {
      const issues = issuesFor({ ...validDescriptor(), thresholds: [] });
      expect(issues.join("\n")).toContain("at least one entry");
    });

    test("rejects a threshold whose operatorAction says nothing actionable", () => {
      const base = validDescriptor();
      const issues = issuesFor({
        ...base,
        thresholds: [{ ...base.thresholds[0]!, operatorAction: "fix it" }]
      });
      expect(issues.join("\n")).toContain("operatorAction");
    });

    test("rejects a dwell time beyond the sanity ceiling", () => {
      const base = validDescriptor();
      const issues = issuesFor({
        ...base,
        thresholds: [{ ...base.thresholds[0]!, forSeconds: 86_401 }]
      });
      expect(issues.join("\n")).toContain("forSeconds");
    });

    test("rejects duplicate threshold keys within one objective", () => {
      const base = validDescriptor();
      const issues = issuesFor({
        ...base,
        thresholds: [base.thresholds[0]!, { ...base.thresholds[0]! }]
      });
      expect(issues.join("\n")).toContain("duplicate thresholdKey");
    });
  });

  describe("identity and ownership", () => {
    test("rejects a descriptor whose key claims another module's namespace", () => {
      const issues = issuesFor({
        ...validDescriptor(),
        key: "payment_gateway.borrowed_namespace"
      });
      expect(issues.join("\n")).toContain("prefixed with its ownerModuleKey");
    });

    test("rejects an ownerModuleKey that is not a registered module", () => {
      const issues = issuesFor({
        ...validDescriptor(),
        key: "not_a_module.example_objective",
        ownerModuleKey: "not_a_module"
      });
      expect(issues.join("\n")).toContain("not a registered module key");
    });

    test("rejects two descriptors sharing one key", () => {
      const result = validateSloRegistry(
        registryWith(validDescriptor(), validDescriptor())
      );
      expect(result.issues.map((issue) => issue.message).join("\n")).toContain(
        "duplicate descriptor key"
      );
    });

    test("rejects a ratio objective expressed as a percentage", () => {
      // 99 instead of 0.99 would make every threshold comparison silently
      // wrong rather than loudly broken.
      const issues = issuesFor({
        ...validDescriptor(),
        unit: "ratio",
        objectiveValue: 99
      });
      expect(issues.join("\n")).toContain("within [0, 1]");
    });
  });

  describe("runbook links", () => {
    test("accepts a docs path with and without an anchor", () => {
      expect(
        validateRunbookPathShape("docs/awcms-mini/control-plane-slo-runbook.md")
      ).toBe(true);
      expect(
        validateRunbookPathShape(
          "docs/awcms-mini/control-plane-slo-runbook.md#payment-gateway-dlq"
        )
      ).toBe(true);
    });

    test("rejects a non-docs, non-markdown, or absolute path", () => {
      expect(validateRunbookPathShape("src/modules/reporting/README.md")).toBe(
        false
      );
      expect(validateRunbookPathShape("docs/awcms-mini/runbook.txt")).toBe(
        false
      );
      expect(validateRunbookPathShape("/etc/passwd")).toBe(false);
    });

    test("strips the anchor so the gate can stat the real file", () => {
      expect(runbookFilePath("docs/a/b.md#anchor-here")).toBe("docs/a/b.md");
      expect(runbookFilePath("docs/a/b.md")).toBe("docs/a/b.md");
    });
  });

  describe("the real registry", () => {
    test("validates, and actually contains objectives", () => {
      const result = validateSloRegistry(listModules());
      expect(
        result.issues.map((issue) => `${issue.descriptorKey}: ${issue.message}`)
      ).toEqual([]);
      // Guards against the whole suite passing vacuously if the descriptors
      // were ever dropped from every module.ts.
      expect(result.descriptors.length).toBeGreaterThan(0);
    });

    test("every objective carries at least one threshold and a runbook anchor", () => {
      for (const descriptor of collectSloDescriptors(listModules())) {
        expect(`${descriptor.key}:${descriptor.thresholds.length > 0}`).toBe(
          `${descriptor.key}:true`
        );
        expect(
          `${descriptor.key}:${descriptor.runbookPath.includes("#")}`
        ).toBe(`${descriptor.key}:true`);
      }
    });

    test("no control-plane metric declares a tenant/resource-identifying label", () => {
      // #930's own acceptance criterion, asserted structurally: control-plane
      // metrics may only be labelled by fixed, code-defined enums.
      const forbidden = [
        "tenantId",
        "tenant_id",
        "resourceId",
        "providerRef",
        "userId"
      ];
      for (const [name, definition] of Object.entries(METRIC_DEFINITIONS)) {
        if (!name.startsWith("control_plane_")) continue;
        for (const label of definition.allowedLabelKeys) {
          expect(`${name}.${label}:${forbidden.includes(label)}`).toBe(
            `${name}.${label}:false`
          );
        }
      }
    });
  });
});
