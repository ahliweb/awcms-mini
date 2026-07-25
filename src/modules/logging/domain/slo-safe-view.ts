/**
 * The operator-facing projection of the SLO registry (Issue #930, epic
 * #868).
 *
 * #930's security requirement for this surface is explicit: "Alert and
 * health endpoints must reveal safe status only, never sensitive
 * configuration values." This file is where that rule is ENFORCED rather
 * than merely intended — the endpoint builds its response from
 * `toSafeObjectiveView` and never from a raw descriptor, so a future field
 * added to `ServiceLevelObjectiveDescriptor` cannot leak into the response
 * by default. It has to be added here deliberately.
 *
 * ## What is deliberately withheld, and why
 *
 * - **`metricName`** — names an internal instrumentation series. Disclosing
 *   the exact metric an alert watches tells an unauthenticated-adjacent
 *   caller which signal to keep below a line.
 * - **Numeric `value` thresholds** — these are capacity and tolerance
 *   limits. Knowing that the payment DLQ pages at 25 rows, or that
 *   provisioning tolerates a 6-hour-old attempt, is precisely the
 *   calibration data needed to stay just under an alarm. Severity LABELS
 *   are exposed (an operator needs to know a critical tier exists), the
 *   numbers are not.
 * - **`forSeconds` dwell times** — same reasoning: they describe exactly
 *   how long a degradation can be sustained before anyone is told.
 *
 * These values all live in this repository's source, so withholding them is
 * not secrecy — it is not *serving* them from a running production system
 * to whoever holds one read permission. The two are different exposures.
 *
 * What IS exposed is what an operator responding to a page actually needs:
 * which objective exists, what it promises, what severities it can reach,
 * and where the runbook is.
 */
import type {
  AlertSeverity,
  ServiceLevelObjectiveDescriptor,
  SloObjectiveKind
} from "../../_shared/module-contract";

export type SafeObjectiveView = {
  key: string;
  ownerModuleKey: string;
  title: string;
  description: string;
  kind: SloObjectiveKind;
  unit: ServiceLevelObjectiveDescriptor["unit"];
  /** Which severities this objective is capable of reaching, ascending. Never the numbers that trigger them. */
  severities: AlertSeverity[];
  /** What an operator should do, per severity — the actionable half, which carries no capacity information. */
  operatorActions: { severity: AlertSeverity; action: string }[];
  runbookPath: string;
};

const SEVERITY_ORDER: readonly AlertSeverity[] = [
  "info",
  "warning",
  "critical"
];

function sortSeverities(severities: Iterable<AlertSeverity>): AlertSeverity[] {
  return [...new Set(severities)].sort(
    (left, right) =>
      SEVERITY_ORDER.indexOf(left) - SEVERITY_ORDER.indexOf(right)
  );
}

/**
 * Builds the response shape from an explicit allow-list of fields. Never
 * spread the descriptor here — the whole protection is that adding a field
 * to the descriptor type does not silently add it to the response.
 */
export function toSafeObjectiveView(
  descriptor: ServiceLevelObjectiveDescriptor
): SafeObjectiveView {
  return {
    key: descriptor.key,
    ownerModuleKey: descriptor.ownerModuleKey,
    title: descriptor.title,
    description: descriptor.description,
    kind: descriptor.kind,
    unit: descriptor.unit,
    severities: sortSeverities(
      descriptor.thresholds.map((threshold) => threshold.severity)
    ),
    operatorActions: sortSeverities(
      descriptor.thresholds.map((threshold) => threshold.severity)
    ).map((severity) => ({
      severity,
      action:
        descriptor.thresholds.find(
          (threshold) => threshold.severity === severity
        )?.operatorAction ?? ""
    })),
    runbookPath: descriptor.runbookPath
  };
}

export function toSafeObjectiveViews(
  descriptors: readonly ServiceLevelObjectiveDescriptor[]
): SafeObjectiveView[] {
  return descriptors.map(toSafeObjectiveView);
}
