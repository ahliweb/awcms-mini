/**
 * Module-contributed SLO/alert registry validation gate (Issue #930, epic
 * #868 SaaS control plane). Pure code-registry validation — no I/O, no
 * database, no network — the same shape as
 * `data-lifecycle/domain/lifecycle-registry.ts`'s
 * `validateLifecycleRegistry` and `reporting/domain/projection-registry.ts`'s
 * `validateProjectionRegistry`, both of which `bun run check` already wires
 * in. This file's `validateSloRegistry` is wired the same way by
 * `scripts/slo-registry-check.ts` (`bun run slo:registry:check`).
 *
 * Every `ServiceLevelObjectiveDescriptor` is declared by its OWNING module's
 * own `module.ts` (`ModuleDescriptor.serviceLevelObjectives`) — this file
 * only AGGREGATES and VALIDATES what modules already declared. It never
 * invents an objective and never reaches into another module's schema.
 *
 * ## The two rules that carry actual safety weight
 *
 * 1. **`metricName` must be declared in `METRIC_DEFINITIONS`.** An objective
 *    evaluated against a metric nothing emits is permanently silent — it
 *    looks like coverage on a dashboard and pages nobody. Because
 *    `METRIC_DEFINITIONS` is the same registry `recordCounter`/`recordGauge`
 *    enforce at emit time, "declared" here means "actually emittable".
 *
 * 2. **`dimension` must be one of THAT metric's own `allowedLabelKeys`.**
 *    This is what makes #930's "SLOs and alerts use low-cardinality
 *    dimensions" true by construction rather than by review. An objective
 *    cannot introduce a label, so it cannot introduce a tenant id, provider
 *    reference, or resource id as an alert dimension — the metric registry
 *    already bounded that set, and the emit path silently drops anything
 *    outside it.
 *
 * The runbook-file-exists check deliberately does NOT live here: it needs
 * filesystem access, and this module stays pure so it can run inside a test
 * or a request without touching disk. `scripts/slo-registry-check.ts` layers
 * that check on top — see `validateRunbookPathShape` below for the part that
 * IS checkable without I/O.
 */
import {
  METRIC_DEFINITIONS,
  type MetricDefinition
} from "../../../lib/observability/metrics-port";
import type {
  AlertThresholdDescriptor,
  ModuleDescriptor,
  ServiceLevelObjectiveDescriptor
} from "../../_shared/module-contract";

const DESCRIPTOR_KEY_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Runbook links are repo-relative markdown paths with an optional `#anchor`. */
const RUNBOOK_PATH_PATTERN = /^docs\/[A-Za-z0-9._\-/]+\.md(#[a-z0-9-]+)?$/;

/**
 * An alert that must persist for longer than this before firing is, in
 * practice, an alert that fires after the incident is over. Not a hard
 * correctness bound — a sanity ceiling, the same defense-in-depth role
 * `MAX_LIFECYCLE_BATCH_LIMIT`/`MAX_PROJECTION_BATCH_LIMIT` play.
 */
export const MAX_ALERT_DWELL_SECONDS = 24 * 60 * 60;

export type SloRegistryIssue = {
  descriptorKey: string;
  message: string;
};

export function formatSloRegistryIssue(issue: SloRegistryIssue): string {
  return `[${issue.descriptorKey}] ${issue.message}`;
}

/** Flattens every registered module's own `serviceLevelObjectives` array into one list. Order follows `modules` (i.e. `listModules()`), stable and deterministic. */
export function collectSloDescriptors(
  modules: readonly ModuleDescriptor[]
): ServiceLevelObjectiveDescriptor[] {
  return modules.flatMap((module) => module.serviceLevelObjectives ?? []);
}

/**
 * The part of the runbook link that IS checkable without touching disk —
 * shape only. `scripts/slo-registry-check.ts` additionally asserts the file
 * exists; keeping the shape rule here means a descriptor with an obviously
 * malformed path fails even in a pure unit test.
 */
export function validateRunbookPathShape(path: string): boolean {
  return RUNBOOK_PATH_PATTERN.test(path);
}

/** Strips the optional `#anchor` so a caller can stat the file itself. */
export function runbookFilePath(runbookPath: string): string {
  const hashIndex = runbookPath.indexOf("#");
  return hashIndex === -1 ? runbookPath : runbookPath.slice(0, hashIndex);
}

function validateThreshold(
  push: (message: string) => void,
  threshold: AlertThresholdDescriptor,
  metric: MetricDefinition | undefined,
  index: number
): void {
  const context = `thresholds[${index}]`;

  if (
    !threshold.thresholdKey ||
    !IDENTIFIER_PATTERN.test(threshold.thresholdKey)
  ) {
    push(
      `${context}: thresholdKey must be a snake_case identifier (got ${JSON.stringify(threshold.thresholdKey)}).`
    );
  }

  if (!Number.isFinite(threshold.value)) {
    push(`${context}: value must be a finite number.`);
  }

  if (
    !Number.isInteger(threshold.forSeconds) ||
    threshold.forSeconds < 0 ||
    threshold.forSeconds > MAX_ALERT_DWELL_SECONDS
  ) {
    push(
      `${context}: forSeconds must be an integer between 0 and ${MAX_ALERT_DWELL_SECONDS} (got ${JSON.stringify(threshold.forSeconds)}).`
    );
  }

  if (
    !threshold.operatorAction ||
    threshold.operatorAction.trim().length < 10
  ) {
    push(
      `${context}: operatorAction must say what an operator should DO (at least 10 characters) — a threshold nobody knows how to action is noise.`
    );
  }

  // A counter only ever goes up, so "below" can never recover and the alert
  // would latch on forever once tripped.
  if (metric?.type === "counter" && threshold.comparison === "below") {
    push(
      `${context}: comparison "below" is meaningless against counter metric "${metric.name}" — a monotonically increasing counter can never fall back below a threshold, so this alert would latch forever.`
    );
  }
}

function validateDescriptor(
  push: (message: string) => void,
  descriptor: ServiceLevelObjectiveDescriptor,
  ownerModuleKeys: ReadonlySet<string>
): void {
  if (!descriptor.key || !DESCRIPTOR_KEY_PATTERN.test(descriptor.key)) {
    push(
      `key must be "<owner_module_key>.<name>" in snake_case (got ${JSON.stringify(descriptor.key)}).`
    );
  }

  if (!ownerModuleKeys.has(descriptor.ownerModuleKey)) {
    push(
      `ownerModuleKey ${JSON.stringify(descriptor.ownerModuleKey)} is not a registered module key.`
    );
  } else if (!descriptor.key.startsWith(`${descriptor.ownerModuleKey}.`)) {
    push(
      `key must be prefixed with its ownerModuleKey ("${descriptor.ownerModuleKey}.") — a descriptor whose key claims another module's namespace would be attributed to the wrong owner on the operator surface.`
    );
  }

  if (!descriptor.title || descriptor.title.trim().length === 0) {
    push("title must be non-empty.");
  }

  if (!descriptor.description || descriptor.description.trim().length < 20) {
    push(
      "description must explain what the objective promises in operator language (at least 20 characters)."
    );
  }

  const metric = (
    METRIC_DEFINITIONS as Record<string, MetricDefinition | undefined>
  )[descriptor.metricName];

  if (!metric) {
    push(
      `metricName ${JSON.stringify(descriptor.metricName)} is not declared in METRIC_DEFINITIONS (src/lib/observability/metrics-port.ts) — an objective evaluated against a metric nothing emits is permanently silent.`
    );
  } else if (descriptor.dimension !== undefined) {
    if (!metric.allowedLabelKeys.includes(descriptor.dimension)) {
      push(
        `dimension ${JSON.stringify(descriptor.dimension)} is not one of metric "${metric.name}"'s allowedLabelKeys (${metric.allowedLabelKeys.join(", ") || "none"}) — alert dimensions must come from the metric registry's already-bounded label set, which is what keeps them low-cardinality and free of tenant/resource ids.`
      );
    }
  }

  if (!validateRunbookPathShape(descriptor.runbookPath)) {
    push(
      `runbookPath must be a repo-relative docs/*.md path with an optional #anchor (got ${JSON.stringify(descriptor.runbookPath)}).`
    );
  }

  if (!Number.isFinite(descriptor.objectiveValue)) {
    push("objectiveValue must be a finite number.");
  }

  if (descriptor.unit === "ratio") {
    if (descriptor.objectiveValue < 0 || descriptor.objectiveValue > 1) {
      push(
        `objectiveValue must be within [0, 1] for unit "ratio" (got ${descriptor.objectiveValue}) — a ratio expressed as a percentage here would make every threshold comparison silently wrong.`
      );
    }
  }

  if (descriptor.thresholds.length === 0) {
    push(
      "thresholds must contain at least one entry — an objective that cannot page anyone is not an objective."
    );
  }

  const seenThresholdKeys = new Set<string>();
  descriptor.thresholds.forEach((threshold, index) => {
    if (seenThresholdKeys.has(threshold.thresholdKey)) {
      push(`duplicate thresholdKey ${JSON.stringify(threshold.thresholdKey)}.`);
    }
    seenThresholdKeys.add(threshold.thresholdKey);
    validateThreshold(push, threshold, metric, index);

    // Every threshold must describe a departure from the objective in the
    // SAME direction the objective is stated — a "backlog below 5" threshold
    // on an "keep backlog below 100" objective describes the healthy state,
    // so it would fire permanently.
    if (threshold.comparison !== descriptor.objectiveComparison) {
      push(
        `thresholds[${index}]: comparison ${JSON.stringify(threshold.comparison)} contradicts objectiveComparison ${JSON.stringify(descriptor.objectiveComparison)} — a threshold pointing the opposite way from its objective describes the HEALTHY state and would fire permanently.`
      );
    }
  });

  // Severity ordering: a critical threshold must be at least as far past the
  // objective as the warning one. Inverted severities are a real and easily
  // missed authoring bug — the operator gets paged critical before warning.
  const bySeverity = new Map<string, number>();
  for (const threshold of descriptor.thresholds) {
    const existing = bySeverity.get(threshold.severity);
    if (existing === undefined) {
      bySeverity.set(threshold.severity, threshold.value);
      continue;
    }
    bySeverity.set(
      threshold.severity,
      descriptor.objectiveComparison === "above"
        ? Math.max(existing, threshold.value)
        : Math.min(existing, threshold.value)
    );
  }
  const warning = bySeverity.get("warning");
  const critical = bySeverity.get("critical");
  if (warning !== undefined && critical !== undefined) {
    const criticalIsWorse =
      descriptor.objectiveComparison === "above"
        ? critical >= warning
        : critical <= warning;
    if (!criticalIsWorse) {
      push(
        `critical threshold (${critical}) is less severe than the warning threshold (${warning}) for objectiveComparison ${JSON.stringify(descriptor.objectiveComparison)} — the operator would be paged critical before warning.`
      );
    }
  }
}

export type SloRegistryValidationResult = {
  valid: boolean;
  descriptors: ServiceLevelObjectiveDescriptor[];
  issues: SloRegistryIssue[];
};

export function validateSloRegistry(
  modules: readonly ModuleDescriptor[]
): SloRegistryValidationResult {
  const descriptors = collectSloDescriptors(modules);
  const issues: SloRegistryIssue[] = [];
  const ownerModuleKeys = new Set(modules.map((module) => module.key));
  const seenKeys = new Set<string>();

  for (const descriptor of descriptors) {
    const push = (message: string): void => {
      issues.push({ descriptorKey: descriptor.key ?? "<unkeyed>", message });
    };

    if (seenKeys.has(descriptor.key)) {
      push(
        "duplicate descriptor key — two modules (or one module twice) declared the same objective."
      );
    }
    seenKeys.add(descriptor.key);

    validateDescriptor(push, descriptor, ownerModuleKeys);
  }

  return { valid: issues.length === 0, descriptors, issues };
}
