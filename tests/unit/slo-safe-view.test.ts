/**
 * Issue #930: the operator SLO surface must "reveal safe status only, never
 * sensitive configuration values".
 *
 * The interesting risk here is not that today's code leaks — it is that a
 * FUTURE field added to `ServiceLevelObjectiveDescriptor` leaks by default,
 * which is exactly what would happen if the endpoint spread the descriptor.
 * So the central test below is deliberately written against a descriptor
 * carrying an extra unknown field: it fails if the view ever starts passing
 * through anything it was not explicitly told to.
 */
import { describe, expect, test } from "bun:test";

import { listModules } from "../../src/modules";
import type { ServiceLevelObjectiveDescriptor } from "../../src/modules/_shared/module-contract";
import { collectSloDescriptors } from "../../src/modules/logging/domain/slo-registry";
import {
  toSafeObjectiveView,
  toSafeObjectiveViews
} from "../../src/modules/logging/domain/slo-safe-view";

function descriptorWithSecrets(): ServiceLevelObjectiveDescriptor {
  return {
    key: "reporting.example",
    ownerModuleKey: "reporting",
    title: "Example",
    description: "An objective used to prove the safe view withholds fields.",
    kind: "backlog",
    metricName: "control_plane_projection_stale_total",
    dimension: "freshnessState",
    unit: "count",
    objectiveValue: 0,
    objectiveComparison: "above",
    runbookPath: "docs/awcms-mini/control-plane-slo-runbook.md#anchor",
    thresholds: [
      {
        thresholdKey: "warn",
        severity: "warning",
        comparison: "above",
        value: 4242,
        forSeconds: 31337,
        operatorAction: "Run the projection refresh and check its grants."
      },
      {
        thresholdKey: "crit",
        severity: "critical",
        comparison: "above",
        value: 9999,
        forSeconds: 31337,
        operatorAction: "Escalate — several projections stale at once."
      }
    ]
  };
}

describe("SLO safe view (Issue #930)", () => {
  test("withholds metric names, threshold values, and dwell times", () => {
    const serialized = JSON.stringify(
      toSafeObjectiveView(descriptorWithSecrets())
    );

    // Threshold numbers describe how far a degradation may go before anyone
    // is told — the calibration data for staying just under an alarm.
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("31337");
    // The instrumentation series an alert watches.
    expect(serialized).not.toContain("control_plane_projection_stale_total");
    expect(serialized).not.toContain("freshnessState");
  });

  test("still exposes what a responder actually needs", () => {
    const view = toSafeObjectiveView(descriptorWithSecrets());
    expect(view.key).toBe("reporting.example");
    expect(view.severities).toEqual(["warning", "critical"]);
    expect(view.runbookPath).toBe(
      "docs/awcms-mini/control-plane-slo-runbook.md#anchor"
    );
    expect(view.operatorActions.map((entry) => entry.severity)).toEqual([
      "warning",
      "critical"
    ]);
  });

  test("does not pass through a field it was not explicitly told to expose", () => {
    // The regression that matters: if the view is ever rewritten to spread
    // the descriptor, this leaks and the test goes red.
    const withFutureField = {
      ...descriptorWithSecrets(),
      internalConnectionString: "postgres://user:hunter2@db.internal:5432/x"
    } as ServiceLevelObjectiveDescriptor;

    const serialized = JSON.stringify(toSafeObjectiveView(withFutureField));
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("db.internal");
    expect(serialized).not.toContain("internalConnectionString");
  });

  test("severities are ordered by escalation, not declaration order", () => {
    const base = descriptorWithSecrets();
    const reversed = toSafeObjectiveView({
      ...base,
      thresholds: [base.thresholds[1]!, base.thresholds[0]!]
    });
    expect(reversed.severities).toEqual(["warning", "critical"]);
  });

  test("the real registry's safe view leaks no threshold number", () => {
    const descriptors = collectSloDescriptors(listModules());
    const serialized = JSON.stringify(toSafeObjectiveViews(descriptors));

    for (const descriptor of descriptors) {
      for (const threshold of descriptor.thresholds) {
        // Guard against the assertion being vacuous for a 0-valued
        // threshold, whose digit trivially appears in other numbers.
        if (threshold.value === 0) continue;
        expect(
          `${descriptor.key}/${threshold.thresholdKey}:${serialized.includes(String(threshold.value))}`
        ).toBe(`${descriptor.key}/${threshold.thresholdKey}:false`);
      }
      expect(
        `${descriptor.key}:${serialized.includes(descriptor.metricName)}`
      ).toBe(`${descriptor.key}:false`);
    }
  });
});
