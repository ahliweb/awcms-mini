/**
 * Versioned provisioning plan/step registry (Issue #872, epic #868, ADR-0022
 * §11.1). A PLAN is an ordered, versioned list of step DEFINITIONS the engine
 * materializes into `awcms_mini_tenant_provisioning_steps` rows at request
 * time. The base ships one reviewed plan (`standard_tenant` v1) covering the
 * core tenant-onboarding steps; a DERIVED application contributes its own
 * versioned plans (and step handlers, see
 * `infrastructure/step-handler-registry.ts`) through `registerProvisioningPlan`
 * from its composition root — a static, reviewed-source registration seam (no
 * runtime discovery/upload/`eval`; doc 21 §7). This registry is DIFFERENT from
 * the commercial feature/meter registry (#874) — it composes provisioning
 * steps, not catalog keys — so the two never conflict.
 *
 * A plan is IMMUTABLE once shipped: changing the step set is a NEW plan version
 * (existing runs keep replaying their pinned `(planKey, planVersion)`), exactly
 * like `service_catalog` offer versions.
 */
import type {
  ProvisioningCompensationClass,
  ProvisioningStepDefinition,
  ProvisioningStepKind
} from "../../_shared/ports/provisioning-step-port";

export type {
  ProvisioningStepDefinition,
  ProvisioningStepKind,
  ProvisioningCompensationClass
};

export type ProvisioningPlan = {
  planKey: string;
  version: number;
  description: string;
  steps: readonly ProvisioningStepDefinition[];
};

/**
 * Canonical core step keys (stable identifiers referenced by the base plan and
 * the core step handlers). Exposed so tests + the handler registry stay in sync
 * with the plan without a hand-kept duplicate list.
 */
export const CORE_STEP_KEYS = {
  tenantBootstrap: "tenant_bootstrap",
  ownerIdentity: "owner_identity",
  defaultConfiguration: "default_configuration",
  entitlementAssignment: "entitlement_assignment",
  modulePreset: "module_preset",
  subdomainRequest: "subdomain_request",
  readinessCheck: "readiness_check"
} as const;

/**
 * The base `standard_tenant` plan v1. Order matters (dependencies flow
 * forward): the tenant record + owner exist before configuration/entitlement/
 * modules, and readiness is LAST (it gates the tenant becoming active).
 *
 * `tenant_bootstrap` is `forbidden` (the tenant record is never deleted as
 * compensation — ADR-0022 §6/§9). `owner_identity` is `manual` (an owner is
 * never auto-deleted; a failed run leaves it for operator review, never a
 * silent delete). Configuration/entitlement/module/subdomain are `reversible`
 * (config reset / entitlement cancel / module disable / domain deactivate — all
 * state changes, never data deletes). Optional steps (entitlement, module
 * preset, subdomain) are SKIPPED when not applicable — a LAN/offline run with
 * no subdomain and the entitlement/module capabilities absent still provisions.
 * `readiness_check` is `forbidden` (verification only, nothing to undo).
 */
const STANDARD_TENANT_V1: ProvisioningPlan = {
  planKey: "standard_tenant",
  version: 1,
  description:
    "Baseline tenant onboarding: tenant record, owner identity, default configuration, optional entitlement/module preset, optional subdomain, and mandatory readiness.",
  steps: [
    {
      stepKey: CORE_STEP_KEYS.tenantBootstrap,
      kind: "core",
      compensationClass: "forbidden",
      optional: false,
      maxAttempts: 1,
      description:
        "Create the tenant registry record + settings (done atomically at request time; never deleted)."
    },
    {
      stepKey: CORE_STEP_KEYS.ownerIdentity,
      kind: "core",
      compensationClass: "manual",
      optional: false,
      maxAttempts: 3,
      description:
        "Create the owner profile/identity/tenant-user/role + head office (reuses tenant_admin onboarding)."
    },
    {
      stepKey: CORE_STEP_KEYS.defaultConfiguration,
      kind: "core",
      compensationClass: "reversible",
      optional: false,
      maxAttempts: 3,
      description: "Apply default locale/theme/timezone."
    },
    {
      stepKey: CORE_STEP_KEYS.entitlementAssignment,
      kind: "core",
      compensationClass: "reversible",
      optional: true,
      maxAttempts: 3,
      description:
        "Assign the plan's published offer via the tenant_entitlement port (skipped when no offer / capability absent)."
    },
    {
      stepKey: CORE_STEP_KEYS.modulePreset,
      kind: "core",
      compensationClass: "reversible",
      optional: true,
      maxAttempts: 3,
      description:
        "Apply a module activation preset via module_management (skipped when no preset / capability absent)."
    },
    {
      stepKey: CORE_STEP_KEYS.subdomainRequest,
      kind: "provider",
      compensationClass: "reversible",
      optional: true,
      maxAttempts: 5,
      description:
        "Request an optional subdomain/domain via tenant_domain (skipped when none requested or the provider is disabled — LAN/offline safe)."
    },
    {
      stepKey: CORE_STEP_KEYS.readinessCheck,
      kind: "core",
      compensationClass: "forbidden",
      optional: false,
      maxAttempts: 3,
      description:
        "Verify mandatory security controls (owner + assignment present) before the tenant becomes active; otherwise leave it inactive + blocked."
    }
  ]
};

const basePlans = new Map<string, ProvisioningPlan>();
const contributedPlans = new Map<string, ProvisioningPlan>();

function planRegistryKey(planKey: string, version: number): string {
  return `${planKey}@${version}`;
}

function validatePlanShape(plan: ProvisioningPlan): void {
  if (!/^[a-z][a-z0-9_]*$/.test(plan.planKey) || plan.planKey.length > 100) {
    throw new Error(`tenant_provisioning: invalid plan key "${plan.planKey}"`);
  }
  if (!Number.isInteger(plan.version) || plan.version < 1) {
    throw new Error(
      `tenant_provisioning: plan "${plan.planKey}" version must be a positive integer`
    );
  }
  if (plan.steps.length === 0) {
    throw new Error(
      `tenant_provisioning: plan "${plan.planKey}" must declare at least one step`
    );
  }
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (!/^[a-z][a-z0-9_]*$/.test(step.stepKey) || step.stepKey.length > 100) {
      throw new Error(
        `tenant_provisioning: plan "${plan.planKey}" has an invalid step key "${step.stepKey}"`
      );
    }
    if (seen.has(step.stepKey)) {
      throw new Error(
        `tenant_provisioning: plan "${plan.planKey}" has a duplicate step key "${step.stepKey}"`
      );
    }
    seen.add(step.stepKey);
  }
}

validatePlanShape(STANDARD_TENANT_V1);
basePlans.set(
  planRegistryKey(STANDARD_TENANT_V1.planKey, STANDARD_TENANT_V1.version),
  STANDARD_TENANT_V1
);

/**
 * Register a derived-application provisioning plan (composition root only). A
 * plan version is immutable once registered; re-registering the same
 * `(planKey, version)` with a different shape is rejected.
 */
export function registerProvisioningPlan(plan: ProvisioningPlan): void {
  validatePlanShape(plan);
  const key = planRegistryKey(plan.planKey, plan.version);
  if (basePlans.has(key)) {
    throw new Error(
      `tenant_provisioning: cannot override the base plan "${key}"`
    );
  }
  const existing = contributedPlans.get(key);
  if (existing && JSON.stringify(existing) !== JSON.stringify(plan)) {
    throw new Error(
      `tenant_provisioning: plan "${key}" is already registered with a different shape (a plan version is immutable)`
    );
  }
  contributedPlans.set(key, plan);
}

/** For tests: drop contributed plans (never touches base plans). */
export function resetContributedProvisioningPlans(): void {
  contributedPlans.clear();
}

/** Resolve a plan by key + version (base first, then contributed). `null` when unknown (the request layer rejects it — fail-closed). */
export function getProvisioningPlan(
  planKey: string,
  version: number
): ProvisioningPlan | null {
  const key = planRegistryKey(planKey, version);
  return basePlans.get(key) ?? contributedPlans.get(key) ?? null;
}

/** Latest registered version of a plan key (base + contributed). `null` when the key is unknown. */
export function getLatestProvisioningPlan(
  planKey: string
): ProvisioningPlan | null {
  let latest: ProvisioningPlan | null = null;
  for (const plan of [...basePlans.values(), ...contributedPlans.values()]) {
    if (
      plan.planKey === planKey &&
      (!latest || plan.version > latest.version)
    ) {
      latest = plan;
    }
  }
  return latest;
}

export function listProvisioningPlans(): readonly ProvisioningPlan[] {
  return [...basePlans.values(), ...contributedPlans.values()];
}

export { STANDARD_TENANT_V1 };
