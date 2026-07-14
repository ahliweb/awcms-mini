/**
 * reference-data-contributions-check.ts — `bun run
 * reference-data:contributions:check`.
 *
 * Issue #750 (epic #738 platform-evolution, Wave 3, ADR-0021). Static
 * module-contribution registry validation gate — same shape as
 * `scripts/identity-access-sod-registry-check.ts` (`bun run
 * identity-access:sod-registry:check`, Issue #746): pure code-registry
 * (`listModules()`) validation, no I/O, no network, no database, safe to
 * run on every CI build.
 */
import { listModules } from "../src/modules";
import {
  formatReferenceDataContributionIssue,
  validateReferenceDataContributionRegistry
} from "../src/modules/reference-data/domain/contribution-registry";

function main(): void {
  const result = validateReferenceDataContributionRegistry(listModules());

  if (result.valid) {
    console.log(
      `reference-data:contributions:check OK — ${result.contributions.length} registered value-set contribution(s) are valid.`
    );
    return;
  }

  console.error("reference-data:contributions:check FAILED —");
  for (const issue of result.issues) {
    console.error(`  ${formatReferenceDataContributionIssue(issue)}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
