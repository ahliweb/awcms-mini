/**
 * validate-module-graph.ts — `bun run modules:dag:check`.
 *
 * Issue #680 (epic #679, platform-hardening). Registry-wide dependency-DAG
 * gate: fails loud if any registered module descriptor introduces a
 * self-dependency, a duplicate dependency, a missing dependency key, or a
 * cycle (direct or indirect) — see
 * `src/modules/module-management/domain/module-dependency-graph.ts`'s own
 * header comment for why this is a DIFFERENT check from
 * `domain/tenant-module-lifecycle.ts`'s `hasDependencyCycle` (that one only
 * ever validates a single module at enable-time; this walks the WHOLE
 * registry). No I/O, no network, no database — pure code-registry
 * (`listModules()`) validation, safe to run on every CI build and before
 * every `bun run modules:sync`.
 */
import { listModules } from "../src/modules";
import {
  formatModuleDependencyGraphIssue,
  validateModuleDependencyGraph
} from "../src/modules/module-management/domain/module-dependency-graph";

function main(): void {
  const result = validateModuleDependencyGraph(listModules());

  if (result.valid) {
    console.log(
      `modules:dag:check OK — ${listModules().length} registered modules form a valid DAG.`
    );
    return;
  }

  console.error("modules:dag:check FAILED —");
  for (const issue of result.issues) {
    console.error(`  ${formatModuleDependencyGraphIssue(issue)}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
