/**
 * Core provisioning step handlers (Issue #872, epic #868, ADR-0022). These are
 * the BASE plan's step implementations, built as CLOSURES over injected
 * cross-module dependencies (`CoreStepDeps`) assembled at the composition root
 * (the route). Keeping the cross-module wiring in the injected deps means this
 * module's `application`/`domain` never imports another module's code directly
 * (`tests/unit/module-boundary.test.ts`) — the same DI seam the engine offers
 * derived apps via `registerProvisioningStep`.
 *
 * `tenant_bootstrap` and `owner_identity` are executed ATOMICALLY at request
 * time (they need the request-time owner secret, which is never stored), so the
 * engine sees them pre-completed and never calls their `execute`. The RESUMABLE
 * steps the engine runs are configuration/entitlement/module/subdomain/
 * readiness. Optional steps (entitlement, module preset, subdomain) SKIP when
 * their capability is absent/disabled or the input is missing — a LAN/offline
 * run with every provider step absent still provisions (AC). Every handler is
 * IDEMPOTENT (safe to re-run on resume) and stores only minimized/redacted
 * output — never a secret (ADR-0022 §3/§6/§8).
 */
import type {
  ProvisioningStepContext,
  ProvisioningStepExecution,
  ProvisioningStepCompensation,
  ProvisioningStepHandler
} from "../../_shared/ports/provisioning-step-port";
import { CORE_STEP_KEYS } from "../domain/provisioning-plan";

/** Result of an optional capability call — the engine maps `skipped`/`failed` to the step outcome. */
export type CapabilityAssignResult =
  | { ok: true; assignmentId: string }
  | { ok: false; reason: "offer_not_found" | "validation" | "conflict" };

export type CapabilitySubdomainResult =
  | { ok: true; domainId: string }
  | { ok: false; reason: "taken" | "validation" };

/**
 * Injected cross-module capabilities. Optional capabilities that are `undefined`
 * cause their step to SKIP (LAN/offline safe). Concrete adapters are imported +
 * wired at the composition root (route), never inside this module's app/domain.
 */
export type CoreStepDeps = {
  /** Apply default locale/theme/timezone (reuses `tenant_admin` `applyTenantConfiguration`). */
  applyConfiguration(
    tx: Bun.SQL,
    tenantId: string,
    config: {
      locale: string | null;
      theme: string | null;
      timezone: string | null;
    }
  ): Promise<void>;
  /** Flip the tenant to `active` once readiness passes (reuses `tenant_admin` `setTenantStatus`). */
  setTenantActive(
    tx: Bun.SQL,
    tenantId: string,
    actorTenantUserId: string | null
  ): Promise<void>;
  /** Verify mandatory SECURITY controls (an owner identity with credentials exists). Missing -> the run blocks, the tenant stays inactive. */
  verifyMandatoryControls(
    tx: Bun.SQL,
    tenantId: string
  ): Promise<{ ready: boolean; missing: string[] }>;
  /** Optional entitlement assignment (reuses `tenant_entitlement` at the composition root). */
  entitlement?: {
    assign(
      tx: Bun.SQL,
      tenantId: string,
      actorTenantUserId: string | null,
      offer: { offerPlanKey: string; offerVersion: number }
    ): Promise<CapabilityAssignResult>;
    cancel(
      tx: Bun.SQL,
      tenantId: string,
      actorTenantUserId: string | null,
      assignmentId: string
    ): Promise<void>;
  };
  /** Optional module preset (reuses `module_management` at the composition root). */
  modulePreset?: {
    apply(
      tx: Bun.SQL,
      tenantId: string,
      actorTenantUserId: string | null,
      presetKey: string
    ): Promise<{ appliedModules: string[] }>;
    revert(
      tx: Bun.SQL,
      tenantId: string,
      actorTenantUserId: string | null,
      presetKey: string
    ): Promise<void>;
  };
  /** Optional subdomain/domain request (reuses `tenant_domain` at the composition root). */
  subdomain?: {
    request(
      tx: Bun.SQL,
      tenantId: string,
      actorTenantUserId: string | null,
      subdomain: string
    ): Promise<CapabilitySubdomainResult>;
    deactivate(
      tx: Bun.SQL,
      tenantId: string,
      actorTenantUserId: string | null,
      domainId: string
    ): Promise<void>;
  };
};

function optString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Build the base plan's core step handlers as closures over `deps`. The engine
 * resolves these before the derived-step registry.
 */
export function createCoreStepHandlers(
  deps: CoreStepDeps
): Map<string, ProvisioningStepHandler> {
  const handlers = new Map<string, ProvisioningStepHandler>();

  // tenant_bootstrap / owner_identity are pre-completed at request time. Handlers
  // exist only for defence (a plan that leaves them pending) — idempotent verify.
  handlers.set(CORE_STEP_KEYS.tenantBootstrap, {
    stepKey: CORE_STEP_KEYS.tenantBootstrap,
    async execute(): Promise<ProvisioningStepExecution> {
      return { outcome: "completed", resultKind: "tenant_bootstrapped" };
    }
    // forbidden compensation: never called (the tenant record is never deleted).
  });

  handlers.set(CORE_STEP_KEYS.ownerIdentity, {
    stepKey: CORE_STEP_KEYS.ownerIdentity,
    async execute(ctx): Promise<ProvisioningStepExecution> {
      const check = await deps.verifyMandatoryControls(ctx.tx, ctx.tenantId);
      return check.ready
        ? { outcome: "completed", resultKind: "owner_verified" }
        : {
            outcome: "failed",
            errorClass: "validation",
            message: `owner_missing:${check.missing.join(",")}`
          };
    }
    // manual compensation: never auto-reversed (an owner is never silently deleted).
  });

  handlers.set(CORE_STEP_KEYS.defaultConfiguration, {
    stepKey: CORE_STEP_KEYS.defaultConfiguration,
    async execute(ctx): Promise<ProvisioningStepExecution> {
      await deps.applyConfiguration(ctx.tx, ctx.tenantId, {
        locale: optString(ctx.inputs.options.defaultLocale),
        theme: optString(ctx.inputs.options.defaultTheme),
        timezone: optString(ctx.inputs.options.timezone)
      });
      return {
        outcome: "completed",
        resultKind: "configuration_applied",
        output: {
          locale: optString(ctx.inputs.options.defaultLocale),
          theme: optString(ctx.inputs.options.defaultTheme),
          timezone: optString(ctx.inputs.options.timezone)
        }
      };
    },
    async compensate(): Promise<ProvisioningStepCompensation> {
      // Configuration values are not a safety risk; the undo is a no-op record.
      return { outcome: "completed", note: "configuration_reset_noop" };
    }
  });

  handlers.set(CORE_STEP_KEYS.entitlementAssignment, {
    stepKey: CORE_STEP_KEYS.entitlementAssignment,
    async execute(ctx): Promise<ProvisioningStepExecution> {
      const offerPlanKey = optString(ctx.inputs.options.offerPlanKey);
      const offerVersion = optNumber(ctx.inputs.options.offerVersion);
      if (!deps.entitlement || !offerPlanKey || offerVersion === null) {
        return {
          outcome: "skipped",
          reason: !deps.entitlement
            ? "entitlement capability not wired (LAN/offline)"
            : "no offer requested"
        };
      }
      const result = await deps.entitlement.assign(
        ctx.tx,
        ctx.tenantId,
        ctx.actorTenantUserId,
        {
          offerPlanKey,
          offerVersion
        }
      );
      if (!result.ok) {
        return {
          outcome: "failed",
          errorClass: result.reason === "conflict" ? "conflict" : "validation",
          message: `entitlement_${result.reason}`
        };
      }
      return {
        outcome: "completed",
        resultKind: "entitlement_assigned",
        resourceType: "tenant_entitlement_assignment",
        resourceId: result.assignmentId,
        output: { offerPlanKey, offerVersion }
      };
    },
    async compensate(ctx): Promise<ProvisioningStepCompensation> {
      const result = ctx.getResult(CORE_STEP_KEYS.entitlementAssignment);
      if (!deps.entitlement || !result?.resourceId) {
        return { outcome: "completed", note: "no_assignment_to_cancel" };
      }
      await deps.entitlement.cancel(
        ctx.tx,
        ctx.tenantId,
        ctx.actorTenantUserId,
        result.resourceId
      );
      return { outcome: "completed", note: "entitlement_canceled" };
    }
  });

  handlers.set(CORE_STEP_KEYS.modulePreset, {
    stepKey: CORE_STEP_KEYS.modulePreset,
    async execute(ctx): Promise<ProvisioningStepExecution> {
      const presetKey = optString(ctx.inputs.options.presetKey);
      if (!deps.modulePreset || !presetKey) {
        return {
          outcome: "skipped",
          reason: !deps.modulePreset
            ? "module preset capability not wired"
            : "no preset requested"
        };
      }
      const result = await deps.modulePreset.apply(
        ctx.tx,
        ctx.tenantId,
        ctx.actorTenantUserId,
        presetKey
      );
      return {
        outcome: "completed",
        resultKind: "module_preset_applied",
        output: { presetKey, appliedModules: result.appliedModules }
      };
    },
    async compensate(ctx): Promise<ProvisioningStepCompensation> {
      const presetKey = optString(ctx.inputs.options.presetKey);
      if (!deps.modulePreset || !presetKey) {
        return { outcome: "completed", note: "no_preset_to_revert" };
      }
      await deps.modulePreset.revert(
        ctx.tx,
        ctx.tenantId,
        ctx.actorTenantUserId,
        presetKey
      );
      return { outcome: "completed", note: "module_preset_reverted" };
    }
  });

  handlers.set(CORE_STEP_KEYS.subdomainRequest, {
    stepKey: CORE_STEP_KEYS.subdomainRequest,
    async execute(ctx): Promise<ProvisioningStepExecution> {
      const subdomain = optString(ctx.inputs.options.subdomain);
      if (!deps.subdomain || !subdomain) {
        return {
          outcome: "skipped",
          reason: !deps.subdomain
            ? "domain provider disabled (LAN/offline)"
            : "no subdomain requested"
        };
      }
      const result = await deps.subdomain.request(
        ctx.tx,
        ctx.tenantId,
        ctx.actorTenantUserId,
        subdomain
      );
      if (!result.ok) {
        return {
          outcome: "failed",
          errorClass: result.reason === "taken" ? "conflict" : "validation",
          message: `subdomain_${result.reason}`
        };
      }
      return {
        outcome: "completed",
        resultKind: "subdomain_requested",
        resourceType: "tenant_domain",
        resourceId: result.domainId,
        output: { subdomain }
      };
    },
    async compensate(ctx): Promise<ProvisioningStepCompensation> {
      const result = ctx.getResult(CORE_STEP_KEYS.subdomainRequest);
      if (!deps.subdomain || !result?.resourceId) {
        return { outcome: "completed", note: "no_domain_to_deactivate" };
      }
      await deps.subdomain.deactivate(
        ctx.tx,
        ctx.tenantId,
        ctx.actorTenantUserId,
        result.resourceId
      );
      return { outcome: "completed", note: "subdomain_deactivated" };
    }
  });

  handlers.set(CORE_STEP_KEYS.readinessCheck, {
    stepKey: CORE_STEP_KEYS.readinessCheck,
    async execute(ctx): Promise<ProvisioningStepExecution> {
      const check = await deps.verifyMandatoryControls(ctx.tx, ctx.tenantId);
      if (!check.ready) {
        return {
          outcome: "failed",
          errorClass: "validation",
          message: `readiness_blocked:${check.missing.join(",")}`
        };
      }
      // Mandatory controls present -> the tenant becomes active (same-commit).
      await deps.setTenantActive(ctx.tx, ctx.tenantId, ctx.actorTenantUserId);
      return {
        outcome: "completed",
        resultKind: "readiness_verified",
        output: { ready: true }
      };
    }
    // forbidden compensation: never reversed (verification only).
  });

  return handlers;
}
