/**
 * slo-registry-check.ts — `bun run slo:registry:check`.
 *
 * Issue #930 (epic #868 SaaS control plane). Module-contributed SLO/alert
 * registry validation gate — the same shape as
 * `scripts/data-lifecycle-registry-check.ts` and
 * `scripts/reporting-projection-registry-check.ts`: read the code registry
 * (`listModules()`), validate, exit non-zero with actionable diagnostics.
 *
 * Two layers, deliberately split:
 *
 * 1. `validateSloRegistry` (pure, `logging/domain/slo-registry.ts`) — shape,
 *    uniqueness, severity ordering, and the two rules that carry real safety
 *    weight: the named metric must exist in `METRIC_DEFINITIONS`, and the
 *    alert dimension must be one of THAT metric's own `allowedLabelKeys`.
 *    No I/O, so it also runs inside unit tests and at request time.
 *
 * 2. The runbook-file existence check BELOW — needs the filesystem, so it
 *    lives here rather than in the pure module. #930 asks for "runbook
 *    links, validated by a gate", and only an on-disk check actually
 *    validates the link. A dead runbook link found at 3am is worse than no
 *    link at all, because the responder has already spent time trusting it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { listModules } from "../src/modules";
import {
  formatSloRegistryIssue,
  runbookFilePath,
  validateSloRegistry
} from "../src/modules/logging/domain/slo-registry";

const REPO_ROOT = resolve(import.meta.dir, "..");

function main(): void {
  const result = validateSloRegistry(listModules());
  const problems = result.issues.map(formatSloRegistryIssue);

  // Layer 2 — the on-disk half. Only run for descriptors whose path SHAPE
  // already validated; otherwise a malformed path would produce two
  // confusing errors for one mistake.
  const shapeFailedKeys = new Set(
    result.issues
      .filter((issue) => issue.message.startsWith("runbookPath must be"))
      .map((issue) => issue.descriptorKey)
  );

  for (const descriptor of result.descriptors) {
    if (shapeFailedKeys.has(descriptor.key)) continue;
    const filePath = runbookFilePath(descriptor.runbookPath);
    if (!existsSync(resolve(REPO_ROOT, filePath))) {
      problems.push(
        `[${descriptor.key}] runbookPath points at ${filePath}, which does not exist — an alert whose runbook link is dead costs the responder the time they spent trusting it.`
      );
    }
  }

  if (problems.length === 0) {
    const alertCount = result.descriptors.reduce(
      (total, descriptor) => total + descriptor.thresholds.length,
      0
    );
    console.log(
      `slo:registry:check OK — ${result.descriptors.length} service-level objective(s) with ${alertCount} alert threshold(s) are valid, and every runbook link resolves.`
    );
    return;
  }

  console.error("slo:registry:check FAILED —");
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exitCode = 1;
}

main();
