/**
 * Provisioning step-handler registry (Issue #872, epic #868, ADR-0022 §2/§9).
 * The static, reviewed-source composition seam a DERIVED application registers
 * its contributed step handlers into (via `registerProvisioningStep`) — the
 * same inversion `domain_event_runtime`'s consumer registry uses (a base
 * function derived code calls; the base never imports derived code back). No
 * runtime discovery/upload/`eval` (doc 21 §7 / ADR-0012 §7).
 *
 * CORE step handlers are NOT registered here — they are closures over injected
 * cross-module dependencies (`application/core-step-handlers.ts`,
 * `createCoreStepHandlers`) assembled at the composition root, so this module's
 * `domain`/`application` never imports another module's code
 * (`tests/unit/module-boundary.test.ts`). The orchestrator resolves a step's
 * handler as: core handlers first, then this registry (derived). A step with no
 * resolvable handler FAILS CLOSED (the run blocks — never a silent success).
 */
import type { ProvisioningStepHandler } from "../../_shared/ports/provisioning-step-port";

const contributedHandlers = new Map<string, ProvisioningStepHandler>();

/**
 * Register a derived-application provisioning step handler (composition root
 * only). Re-registering the same `stepKey` with a different handler object is
 * rejected — a step handler is a fixed, reviewed contribution.
 */
export function registerProvisioningStep(
  handler: ProvisioningStepHandler
): void {
  if (!/^[a-z][a-z0-9_]*$/.test(handler.stepKey)) {
    throw new Error(
      `tenant_provisioning: invalid contributed step key "${handler.stepKey}"`
    );
  }
  const existing = contributedHandlers.get(handler.stepKey);
  if (existing && existing !== handler) {
    throw new Error(
      `tenant_provisioning: step "${handler.stepKey}" is already registered with a different handler`
    );
  }
  contributedHandlers.set(handler.stepKey, handler);
}

export function getContributedProvisioningStep(
  stepKey: string
): ProvisioningStepHandler | null {
  return contributedHandlers.get(stepKey) ?? null;
}

export function listContributedProvisioningSteps(): readonly ProvisioningStepHandler[] {
  return [...contributedHandlers.values()];
}

/** For tests: drop contributed handlers. */
export function resetContributedProvisioningSteps(): void {
  contributedHandlers.clear();
}
