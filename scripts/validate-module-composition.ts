/**
 * validate-module-composition.ts — `bun run modules:compose:check`.
 *
 * Issue #740 (epic #738 `platform-evolution`, Wave 1). Composes the base
 * registry (`listBaseModules()`) with this repository's own build-time
 * application registry (`src/modules/application-registry.ts` —
 * `undefined` in this base repository, a real `ApplicationModuleRegistry`
 * in a derived repository that has replaced that file) and fails loud with
 * actionable diagnostics if the result is invalid: duplicate module keys,
 * a broken lifecycle dependency DAG (self-dependency/duplicate/missing/
 * cycle — the same whole-registry check `bun run modules:dag:check` runs,
 * a strict subset of what this script validates), missing/conflicting
 * capability provider bindings, a prohibited base-module override/shadow,
 * an invalid application module category, an overlapping migration
 * namespace, an incompatible deployment-profile claim, a navigation path
 * conflict, or an invalid job descriptor.
 *
 * No I/O, no network, no database — pure code-registry composition,
 * same shape as `scripts/validate-module-graph.ts`, safe to run on every
 * CI build. In THIS base repository, `applicationModuleRegistry` is always
 * `undefined`, so this always reduces to validating the base registry
 * alone (already covered by `modules:dag:check`, plus this script's own
 * additional composition-specific checks against base-only data, all of
 * which the base registry is expected to already satisfy).
 */
import { listBaseModules } from "../src/modules";
import { applicationModuleRegistry } from "../src/modules/application-registry";
import {
  composeModuleRegistry,
  formatModuleCompositionIssue
} from "../src/modules/module-management/domain/module-composition";

function main(): void {
  const base = listBaseModules();
  const result = composeModuleRegistry({
    base,
    application: applicationModuleRegistry
  });

  if (result.valid) {
    const applicationSummary = applicationModuleRegistry
      ? ` + ${applicationModuleRegistry.modules.length} application module(s) from "${applicationModuleRegistry.id}"`
      : " + no application registry (base build)";
    console.log(
      `modules:compose:check OK — ${result.registry.length} composed modules (${base.length} base${applicationSummary}).`
    );
    return;
  }

  console.error("modules:compose:check FAILED —");
  for (const issue of result.issues) {
    console.error(`  ${formatModuleCompositionIssue(issue)}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
