/**
 * Tenant module preset application service (Issue #565, epic #555). Plain
 * callable function — no HTTP route in this issue (that's a later
 * issue/the setup wizard's job). Reads current tenant module state, asks
 * `domain/module-presets.ts`'s pure `computeModulePresetPlan` what to
 * enable/disable, then executes that plan exclusively through the existing
 * `enableTenantModule`/`disableTenantModule` lifecycle primitives — never
 * writes `awcms_mini_tenant_modules` directly, never re-implements
 * dependency-graph validation.
 *
 * Idempotency: a second call with the same preset and no state change in
 * between must be a clean no-op success, not a pile of rejections. This is
 * handled by treating the underlying `MODULE_ALREADY_ENABLED`/
 * `MODULE_ALREADY_DISABLED` rejections as an already-satisfied precondition
 * (`outcome: "already_satisfied"` per-module, no audit event written since
 * nothing actually changed) rather than surfacing them as errors. Any other
 * rejection code (`MODULE_DEPENDENCY_MISSING`, `MODULE_DEPENDENCY_DISABLED`,
 * `CORE_MODULE_CANNOT_BE_DISABLED`, `MODULE_REVERSE_DEPENDENCY_ACTIVE`,
 * etc.) is a genuine, reportable outcome — never silently swallowed.
 */
import { listModules } from "../..";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeModulePresetPlan,
  findModulePreset
} from "../domain/module-presets";
import {
  disableTenantModule,
  enableTenantModule,
  fetchTenantModuleEntries
} from "./tenant-module-lifecycle";

export type ModulePresetModuleChange = {
  moduleKey: string;
  action: "enabled" | "disabled";
  /**
   * `applied` — the module's state actually changed this call.
   * `already_satisfied` — the module was already in the target state
   * (idempotent re-application, or another preset already got it there);
   * no audit event was written for this entry since nothing changed.
   * `rejected` — the real lifecycle validation refused the change; `code`/
   * `message` carry the real reason (e.g. `MODULE_DEPENDENCY_DISABLED`).
   */
  outcome: "applied" | "already_satisfied" | "rejected";
  code?: string;
  message?: string;
};

export type ModulePresetSkippedModule = {
  moduleKey: string;
  action: "disabled";
  reason: "reverse_dependency_active";
  message: string;
};

export type ApplyModulePresetResult =
  | {
      outcome: "applied";
      presetName: string;
      /** Every module the plan attempted to enable/disable, one entry each, in the order attempted. */
      changes: ModulePresetModuleChange[];
      /**
       * Modules deliberately left enabled because something that stays
       * enabled still depends on them — planned by the domain layer, never
       * even attempted against `disableTenantModule` (see
       * `domain/module-presets.ts`'s `skippedDisable`).
       */
      skipped: ModulePresetSkippedModule[];
      /** Preset-listed module keys that don't resolve to any registered descriptor — never attempted. */
      unknownModuleKeys: string[];
    }
  | {
      outcome: "rejected";
      code: "MODULE_PRESET_NOT_FOUND";
      message: string;
    };

/**
 * Applies a named module preset for `tenantId`. Callable from any
 * server-side context that already has a transaction and an authenticated
 * actor (future setup wizard step, future tenant-admin "apply preset"
 * action) — this function itself does no auth/ABAC check, same division of
 * responsibility as `enableTenantModule`/`disableTenantModule` (the caller,
 * e.g. an API route, is responsible for `authorizeInTransaction` before
 * calling this).
 */
export async function applyModulePreset(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  presetName: string,
  correlationId?: string | null
): Promise<ApplyModulePresetResult> {
  const preset = findModulePreset(presetName);

  if (!preset) {
    return {
      outcome: "rejected",
      code: "MODULE_PRESET_NOT_FOUND",
      message: `Unknown module preset "${presetName}".`
    };
  }

  const allDescriptors = listModules();
  const entries = await fetchTenantModuleEntries(tx, tenantId);
  const currentState = entries.map((entry) => ({
    moduleKey: entry.moduleKey,
    tenantEnabled: entry.tenantEnabled
  }));

  const plan = computeModulePresetPlan({
    preset,
    allDescriptors,
    currentState
  });

  const changes: ModulePresetModuleChange[] = [];

  for (const moduleKey of plan.toEnable) {
    const result = await enableTenantModule(
      tx,
      tenantId,
      moduleKey,
      actorTenantUserId
    );

    if (result.outcome === "applied") {
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId,
        moduleKey: "module_management",
        action: "tenant_module_enabled",
        resourceType: "tenant_module",
        resourceId: moduleKey,
        severity: "info",
        message: `Module enabled for tenant via preset "${preset.name}": ${moduleKey}.`,
        attributes: { presetName: preset.name },
        correlationId: correlationId ?? undefined
      });
      changes.push({ moduleKey, action: "enabled", outcome: "applied" });
    } else if (result.validation.code === "MODULE_ALREADY_ENABLED") {
      changes.push({
        moduleKey,
        action: "enabled",
        outcome: "already_satisfied"
      });
    } else {
      changes.push({
        moduleKey,
        action: "enabled",
        outcome: "rejected",
        code: result.validation.code,
        message: result.validation.message
      });
    }
  }

  for (const moduleKey of plan.toDisable) {
    const reason = `Module preset "${preset.name}" applied.`;
    const result = await disableTenantModule(
      tx,
      tenantId,
      moduleKey,
      actorTenantUserId,
      reason
    );

    if (result.outcome === "applied") {
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId,
        moduleKey: "module_management",
        action: "tenant_module_disabled",
        resourceType: "tenant_module",
        resourceId: moduleKey,
        severity: "warning",
        message: `Module disabled for tenant via preset "${preset.name}": ${moduleKey}.`,
        attributes: { presetName: preset.name, reason },
        correlationId: correlationId ?? undefined
      });
      changes.push({ moduleKey, action: "disabled", outcome: "applied" });
    } else if (result.validation.code === "MODULE_ALREADY_DISABLED") {
      changes.push({
        moduleKey,
        action: "disabled",
        outcome: "already_satisfied"
      });
    } else {
      changes.push({
        moduleKey,
        action: "disabled",
        outcome: "rejected",
        code: result.validation.code,
        message: result.validation.message
      });
    }
  }

  const skipped: ModulePresetSkippedModule[] = plan.skippedDisable.map(
    (entry) => ({
      moduleKey: entry.moduleKey,
      action: "disabled",
      reason: entry.reason,
      message: `Module "${entry.moduleKey}" still required by an active dependent; not disabled by preset "${preset.name}".`
    })
  );

  return {
    outcome: "applied",
    presetName: preset.name,
    changes,
    skipped,
    unknownModuleKeys: [...plan.unknownModuleKeys]
  };
}
