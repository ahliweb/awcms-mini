/**
 * Control-plane step-up (re-assurance) policy registry — Issue #879 (epic
 * #868 SaaS control plane, Wave 2, ADR-0022 §5/§8).
 *
 * This is a PURE code registry — no I/O, no database, no network — in the
 * same neutral-ground shape as `saas-contract-registry.ts` and the SoD rule
 * registry: it declares WHICH high-risk control-plane permission keys demand
 * a CURRENT authentication assurance (a fresh step-up) before the action may
 * be performed, and the extra guarantees each such action carries (mandatory
 * reason, idempotency, high-severity audit). It does NOT introduce a new
 * identity provider or MFA system (explicitly out of scope for #879) — the
 * runtime consumes the EXISTING MFA/assurance mechanism (`identity-access`'s
 * `mfa.ts`); this registry is only the classification the runtime reads.
 *
 * ADR-0022 §5/§8: "Refund, credit, entitlement override, lifecycle restore,
 * and provider configuration changes require idempotency, mandatory reason,
 * high-severity audit, and step-up/SoD as classified." Those five action
 * classes are the mandatory core below; a handful of adjacent high-risk
 * control-plane actions are classified alongside them.
 *
 * VALIDATION (wired into `bun run control-plane:step-up:check` and
 * `bun run check`). `validateStepUpPolicyRegistry(listModules())` proves,
 * against the LIVE module registry, that every declared `permissionKey`:
 *   1. is structurally a valid `module.activity.action` key;
 *   2. actually EXISTS as a seeded permission on some registered module
 *      (so a renamed/removed control-plane permission can never leave a
 *      step-up policy silently pointing at nothing — the drift-killer);
 *   3. is unique in the registry;
 *   4. carries a sane, bounded `maxAssuranceAgeSeconds`.
 * A policy referencing a non-existent key fails the gate loudly.
 */
import type { ModuleDescriptor } from "./module-contract";

const PERMISSION_KEY_PATTERN =
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export type StepUpActionClass =
  | "refund"
  | "credit"
  | "entitlement_override"
  | "lifecycle_restore"
  | "provider_configuration"
  | "commercial_catalog"
  | "usage_correction"
  | "billing_document";

export type StepUpPolicyDescriptor = {
  /** The `module.activity.action` permission key whose exercise demands step-up. */
  permissionKey: string;
  actionClass: StepUpActionClass;
  /**
   * Maximum age (seconds) of the actor's most recent strong-assurance event
   * (MFA verification) for it to still satisfy this action. Bounded and
   * short — a step-up is "current assurance", not a login-time claim.
   */
  maxAssuranceAgeSeconds: number;
  /** ADR-0022 §8: these actions ALL carry a mandatory operator reason. */
  reasonRequired: true;
  /** ADR-0022 §9: high-risk mutations are idempotent (Idempotency-Key). */
  idempotencyRequired: true;
  severity: "high" | "critical";
  description: string;
};

/**
 * The registry. The first five entries are the ADR-0022 §5/§8 mandatory
 * core (refund / credit / entitlement override / lifecycle restore / provider
 * configuration). The remainder classify adjacent high-risk control-plane
 * actions under the same regime.
 */
export const CONTROL_PLANE_STEP_UP_POLICIES: readonly StepUpPolicyDescriptor[] =
  [
    {
      permissionKey: "payment_gateway.refunds.create",
      actionClass: "refund",
      maxAssuranceAgeSeconds: 300,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "critical",
      description:
        "Requesting a refund starts a money-out flow — refund abuse is a primary control-plane fraud vector (ADR-0022 §5/§8)."
    },
    {
      // Issue #879 — the CHECKER (money-out) step. Approving a requested refund is
      // where the provider dispatch is enqueued; the actor must hold a current
      // assurance at THAT step, not only at request time.
      permissionKey: "payment_gateway.refunds.approve",
      actionClass: "refund",
      maxAssuranceAgeSeconds: 300,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "critical",
      description:
        "Approving a refund enqueues the provider dispatch (money-out) — the checker step must carry a current step-up assurance (ADR-0022 §5/§8)."
    },
    {
      permissionKey: "subscription_billing.credits.create",
      actionClass: "credit",
      maxAssuranceAgeSeconds: 300,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "critical",
      description:
        "Issuing a credit note starts a balance-reduction flow — same monetary-abuse surface as a refund (ADR-0022 §5/§8)."
    },
    {
      // Issue #879 — the CHECKER step: applying a pending credit to the invoice
      // balance is the money-affecting action, gated by step-up.
      permissionKey: "subscription_billing.credits.approve",
      actionClass: "credit",
      maxAssuranceAgeSeconds: 300,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "critical",
      description:
        "Approving a credit applies it to a tenant's invoice balance — the checker step must carry a current step-up assurance (ADR-0022 §5/§8)."
    },
    {
      permissionKey: "tenant_entitlement.overrides.override",
      actionClass: "entitlement_override",
      maxAssuranceAgeSeconds: 300,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "critical",
      description:
        "A manual entitlement override grants/denies a feature/module/quota bypassing the plan — a privileged capability change (ADR-0022 §5/§8)."
    },
    {
      permissionKey: "tenant_lifecycle.states.restore",
      actionClass: "lifecycle_restore",
      maxAssuranceAgeSeconds: 300,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "critical",
      description:
        "Restoring a suspended/canceled tenant reactivates access and billing — irreversible-by-default reactivation (ADR-0022 §5/§8)."
    },
    {
      permissionKey: "payment_gateway.provider_accounts.configure",
      actionClass: "provider_configuration",
      maxAssuranceAgeSeconds: 300,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "critical",
      description:
        "Configuring a payment provider binding controls WHERE money flows — a redirect of settlement is a top-tier fraud vector (ADR-0022 §5/§8)."
    },
    {
      permissionKey: "service_catalog.offers.retire",
      actionClass: "commercial_catalog",
      maxAssuranceAgeSeconds: 600,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "high",
      description:
        "Retiring a published offer withdraws a commercial artifact tenants may be transacting against."
    },
    {
      // Issue #879 (ADR-0022 §5 HIGH-2) — commercial approval gate before publish.
      permissionKey: "service_catalog.offers.approve",
      actionClass: "commercial_catalog",
      maxAssuranceAgeSeconds: 600,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "high",
      description:
        "Commercially approving an offer version authorizes it to be published — the checker step before a public commercial artifact goes live."
    },
    {
      permissionKey: "usage_metering.corrections.correct",
      actionClass: "usage_correction",
      maxAssuranceAgeSeconds: 600,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "high",
      description:
        "A signed usage correction changes a billable quantity — directly affects what a tenant is charged."
    },
    {
      permissionKey: "subscription_billing.invoices.issue",
      actionClass: "billing_document",
      maxAssuranceAgeSeconds: 600,
      reasonRequired: true,
      idempotencyRequired: true,
      severity: "high",
      description:
        "Issuing an invoice freezes a draft into an immutable, legally-meaningful commercial document."
    }
  ];

export type StepUpRegistryIssue = { permissionKey: string; message: string };

export function formatStepUpRegistryIssue(issue: StepUpRegistryIssue): string {
  return `[${issue.permissionKey}] ${issue.message}`;
}

/** All `module.activity.action` permission keys seeded across the registry. */
export function collectSeededPermissionKeys(
  modules: readonly ModuleDescriptor[]
): Set<string> {
  const keys = new Set<string>();
  for (const module of modules) {
    for (const permission of module.permissions ?? []) {
      keys.add(`${module.key}.${permission.activityCode}.${permission.action}`);
    }
  }
  return keys;
}

export type StepUpRegistryValidationResult = {
  valid: boolean;
  issues: StepUpRegistryIssue[];
  policies: readonly StepUpPolicyDescriptor[];
};

export function validateStepUpPolicyRegistry(
  modules: readonly ModuleDescriptor[],
  policies: readonly StepUpPolicyDescriptor[] = CONTROL_PLANE_STEP_UP_POLICIES
): StepUpRegistryValidationResult {
  const issues: StepUpRegistryIssue[] = [];
  const seededKeys = collectSeededPermissionKeys(modules);
  const seen = new Set<string>();

  for (const policy of policies) {
    const push = (message: string) =>
      issues.push({
        permissionKey: policy.permissionKey || "(missing key)",
        message
      });

    if (
      !policy.permissionKey ||
      !PERMISSION_KEY_PATTERN.test(policy.permissionKey)
    ) {
      push(
        `permissionKey must be a valid "module.activity.action" key (got ${JSON.stringify(policy.permissionKey)}).`
      );
    } else {
      if (seen.has(policy.permissionKey)) {
        push("permissionKey is declared more than once in the registry.");
      }
      seen.add(policy.permissionKey);

      if (!seededKeys.has(policy.permissionKey)) {
        push(
          "permissionKey does not match any permission seeded by a registered module — a step-up policy must never point at a non-existent permission (drift)."
        );
      }
    }

    if (
      !Number.isFinite(policy.maxAssuranceAgeSeconds) ||
      policy.maxAssuranceAgeSeconds <= 0 ||
      policy.maxAssuranceAgeSeconds > 3600
    ) {
      push(
        "maxAssuranceAgeSeconds must be a positive number no greater than 3600 (a step-up is current assurance, not a login-time claim)."
      );
    }

    if (policy.reasonRequired !== true) {
      push("reasonRequired must be true (ADR-0022 §8).");
    }
    if (policy.idempotencyRequired !== true) {
      push("idempotencyRequired must be true (ADR-0022 §9).");
    }
    if (policy.severity !== "high" && policy.severity !== "critical") {
      push('severity must be "high" or "critical".');
    }
  }

  return { valid: issues.length === 0, issues, policies };
}

const STEP_UP_KEYS = new Set(
  CONTROL_PLANE_STEP_UP_POLICIES.map((policy) => policy.permissionKey)
);

/** Whether exercising `permissionKey` requires a current step-up assurance. */
export function isStepUpRequired(permissionKey: string): boolean {
  return STEP_UP_KEYS.has(permissionKey);
}

export function getStepUpPolicy(
  permissionKey: string
): StepUpPolicyDescriptor | null {
  return (
    CONTROL_PLANE_STEP_UP_POLICIES.find(
      (policy) => policy.permissionKey === permissionKey
    ) ?? null
  );
}

export type StepUpDecision =
  | { required: false }
  | { required: true; satisfied: true; maxAssuranceAgeSeconds: number }
  | {
      required: true;
      satisfied: false;
      reason: "no_assurance" | "stale_assurance";
      maxAssuranceAgeSeconds: number;
    };

/**
 * Issue #879 (FIX MEDIUM-3) — the RUNTIME step-up decision. PURE (no I/O): the
 * caller passes the actor's most recent strong-assurance timestamp (the session
 * assurance signal) and the request `now`. Fail-CLOSED: a missing assurance, or
 * one older than the registry's `maxAssuranceAgeSeconds`, is NOT satisfied.
 *
 * This is the single consumer point that turns the previously-vacuous registry
 * into an enforced control: `access-guard.ts` denies a high-risk control-plane
 * action whose `permissionKey` is step-up-required unless this returns
 * `satisfied: true`.
 */
export function evaluateStepUp(
  permissionKey: string,
  assuranceAt: Date | null | undefined,
  now: Date
): StepUpDecision {
  const policy = getStepUpPolicy(permissionKey);
  if (!policy) {
    return { required: false };
  }
  if (!assuranceAt) {
    return {
      required: true,
      satisfied: false,
      reason: "no_assurance",
      maxAssuranceAgeSeconds: policy.maxAssuranceAgeSeconds
    };
  }
  const ageSeconds = (now.getTime() - assuranceAt.getTime()) / 1000;
  if (ageSeconds > policy.maxAssuranceAgeSeconds || ageSeconds < 0) {
    return {
      required: true,
      satisfied: false,
      reason: "stale_assurance",
      maxAssuranceAgeSeconds: policy.maxAssuranceAgeSeconds
    };
  }
  return {
    required: true,
    satisfied: true,
    maxAssuranceAgeSeconds: policy.maxAssuranceAgeSeconds
  };
}
