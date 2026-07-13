/**
 * identity-access-sod-registry-check.ts — `bun run
 * identity-access:sod-registry:check`.
 *
 * Issue #746 (epic #738 platform-evolution, Wave 2). Static SoD rule
 * registry validation gate — same shape as `scripts/data-lifecycle-
 * registry-check.ts` (`bun run data-lifecycle:registry:check`, Issue
 * #745): pure code-registry (`listModules()`) validation, no I/O, no
 * network, no database, safe to run on every CI build.
 */
import { listModules } from "../src/modules";
import {
  formatSoDRuleRegistryIssue,
  validateSoDRuleRegistry
} from "../src/modules/identity-access/domain/sod-rule-registry";

function main(): void {
  const result = validateSoDRuleRegistry(listModules());

  if (result.valid) {
    console.log(
      `identity-access:sod-registry:check OK — ${result.rules.length} registered SoD rule(s) are valid.`
    );
    return;
  }

  console.error("identity-access:sod-registry:check FAILED —");
  for (const issue of result.issues) {
    console.error(`  ${formatSoDRuleRegistryIssue(issue)}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
