/**
 * control-plane-step-up-check.ts — `bun run control-plane:step-up:check`.
 *
 * Issue #879 (epic #868 SaaS control plane, Wave 2, ADR-0022 §5/§8). Static
 * validation gate for the control-plane step-up (re-assurance) policy
 * registry — same pure code-registry shape as
 * `scripts/identity-access-sod-registry-check.ts`: no I/O beyond loading the
 * module registry, no network, no database, safe on every CI build.
 *
 * It proves every declared step-up policy points at a REAL seeded permission
 * key (drift-killer) and is structurally sane — see
 * `src/modules/_shared/control-plane-step-up-registry.ts`.
 */
import { listModules } from "../src/modules";
import {
  formatStepUpRegistryIssue,
  validateStepUpPolicyRegistry
} from "../src/modules/_shared/control-plane-step-up-registry";

function main(): void {
  const result = validateStepUpPolicyRegistry(listModules());

  if (result.valid) {
    console.log(
      `control-plane:step-up:check OK — ${result.policies.length} step-up policy(ies) are valid and reference real seeded permissions.`
    );
    return;
  }

  console.error("control-plane:step-up:check FAILED —");
  for (const issue of result.issues) {
    console.error(`  ${formatStepUpRegistryIssue(issue)}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
