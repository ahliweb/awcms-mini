/**
 * Tenant-module matrix read service (Issue #566, epic #555) — the SSR data
 * layer for `/admin/modules/tenants`. Single-tenant scope: this is module x
 * relevant-attribute for the ONE tenant already in the caller's
 * `context.tenantId`, never a genuine cross-tenant view — see that page's
 * own docblock for the full scope decision (this repo's identity model is
 * strictly 1:1 tenant-scoped, `identity-access/README.md`).
 *
 * 100% reuse, zero re-derivation of dependency-graph logic:
 *   - `fetchModuleCatalog` (#514) for static/registry fields.
 *   - `fetchTenantModuleEntries` (#515) for this tenant's enabled state.
 *   - `fetchModuleHealthReport` (#520) for the health pill, same as
 *     `admin/modules.astro`.
 *   - `resolveProtectedModuleKeys` (#565) for the core/protected flag.
 *   - `evaluateModuleEnable`/`evaluateModuleDisable` (#515's own pure domain
 *     functions) for the two per-row warnings below — called with each
 *     module's REAL current state, never a synthetic/forced one, so this
 *     stays an honest re-application of the exact same validation the real
 *     enable/disable endpoints run, not a parallel reimplementation.
 *
 * ## Why only two warning directions, not four
 *
 * `dependencyWarning` is only ever computed for a currently-DISABLED module
 * — "would enabling this module succeed right now?", filtered to the
 * dependency/version-related rejection codes (`MODULE_DEPENDENCY_MISSING`,
 * `MODULE_DEPENDENCY_DISABLED`, `MODULE_DEPENDENCY_CYCLE`,
 * `MODULE_VERSION_INCOMPATIBLE`) — never `MODULE_ALREADY_ENABLED` (not a
 * problem) or `MODULE_NOT_FOUND` (surfaced separately via `status`).
 *
 * `reverseDependencyWarning` is only ever computed for a currently-ENABLED
 * module — "would disabling this module right now be blocked because
 * something still depends on it?", filtered to
 * `MODULE_REVERSE_DEPENDENCY_ACTIVE`.
 *
 * A currently-enabled module's dependencies are guaranteed satisfied by
 * construction: `disableTenantModule` already refuses to disable a
 * dependency while an active dependent remains enabled
 * (`MODULE_REVERSE_DEPENDENCY_ACTIVE`), so "enabled module with a disabled
 * dependency" cannot arise through this app's own guarded lifecycle. Calling
 * `evaluateModuleEnable` on an already-enabled module would only ever
 * short-circuit to `MODULE_ALREADY_ENABLED` before it even reaches the
 * dependency loop — that would be asking the function a question it isn't
 * designed to answer for that state, not a genuine dependency check. This
 * function never works around that short-circuit by forging a fake tenant
 * state; it only ever asks each function the question it is actually
 * designed to answer, for the module's real current state.
 */
import packageJson from "../../../../package.json";
import { listModules } from "../..";
import { fetchModuleCatalog, type ModuleCatalogEntry } from "./module-catalog";
import {
  fetchTenantModuleEntries,
  type TenantModuleListEntry
} from "./tenant-module-lifecycle";
import { fetchModuleHealthReport } from "./health-registry";
import { resolveProtectedModuleKeys } from "../domain/module-presets";
import {
  evaluateModuleDisable,
  evaluateModuleEnable,
  type ModuleLifecycleErrorCode,
  type ModuleTenantState
} from "../domain/tenant-module-lifecycle";

const CURRENT_APP_VERSION = packageJson.version;

const DEPENDENCY_WARNING_CODES: ReadonlySet<ModuleLifecycleErrorCode> = new Set(
  [
    "MODULE_DEPENDENCY_MISSING",
    "MODULE_DEPENDENCY_DISABLED",
    "MODULE_DEPENDENCY_CYCLE",
    "MODULE_VERSION_INCOMPATIBLE"
  ]
);

export type ModuleMatrixWarning = {
  code: ModuleLifecycleErrorCode;
  message: string;
};

export type ModuleMatrixRow = {
  moduleKey: string;
  name: string;
  version: string;
  type: ModuleCatalogEntry["type"];
  status: string;
  isCore: boolean;
  /** `isCore` unioned with the transitive dependency closure of every core module (`resolveProtectedModuleKeys`, #565) — a disable attempt on any of these is guaranteed to be rejected server-side, so the UI never even offers the control. */
  isProtected: boolean;
  tenantEnabled: boolean;
  disableReason: string | null;
  dependencies: string[];
  /** `null` unless `options.includeHealth` was `true`. */
  healthStatus: string | null;
  /** Only ever set for a currently-disabled module. */
  dependencyWarning: ModuleMatrixWarning | null;
  /** Only ever set for a currently-enabled module. */
  reverseDependencyWarning: ModuleMatrixWarning | null;
};

export type ModuleMatrixOptions = {
  /** Pass `false` when the caller lacks `module_management.health.read` — mirrors `admin/modules.astro`'s own permission-gated health fetch. */
  includeHealth: boolean;
  correlationId?: string | null;
};

function toTenantState(entry: TenantModuleListEntry): ModuleTenantState {
  return { moduleKey: entry.moduleKey, tenantEnabled: entry.tenantEnabled };
}

export async function fetchModuleMatrix(
  tx: Bun.SQL,
  tenantId: string,
  options: ModuleMatrixOptions
): Promise<ModuleMatrixRow[]> {
  const [catalog, tenantEntries] = await Promise.all([
    fetchModuleCatalog(tx),
    fetchTenantModuleEntries(tx, tenantId)
  ]);

  const allDescriptors = listModules();
  const descriptorByKey = new Map(allDescriptors.map((d) => [d.key, d]));
  const tenantStateByKey = new Map(
    tenantEntries.map((entry) => [entry.moduleKey, toTenantState(entry)])
  );
  const tenantEntryByKey = new Map(
    tenantEntries.map((entry) => [entry.moduleKey, entry])
  );
  const protectedKeys = resolveProtectedModuleKeys(allDescriptors);

  function resolveTenantState(moduleKey: string): ModuleTenantState {
    return (
      tenantStateByKey.get(moduleKey) ?? { moduleKey, tenantEnabled: true }
    );
  }

  return Promise.all(
    catalog.map(async (entry) => {
      const descriptor = descriptorByKey.get(entry.moduleKey) ?? null;
      const tenantState = resolveTenantState(entry.moduleKey);
      const tenantEntry = tenantEntryByKey.get(entry.moduleKey) ?? null;

      let dependencyWarning: ModuleMatrixRow["dependencyWarning"] = null;
      if (!tenantState.tenantEnabled && descriptor) {
        const dependencyStates = descriptor.dependencies.map((depKey) => {
          const depDescriptor = descriptorByKey.get(depKey) ?? null;
          return depDescriptor
            ? {
                descriptor: depDescriptor,
                tenantState: resolveTenantState(depKey)
              }
            : { descriptor: null, moduleKey: depKey };
        });

        const validation = evaluateModuleEnable({
          target: descriptor,
          targetTenantState: tenantState,
          dependencyStates,
          allDescriptors,
          currentAppVersion: CURRENT_APP_VERSION
        });

        if (
          !validation.valid &&
          DEPENDENCY_WARNING_CODES.has(validation.code)
        ) {
          dependencyWarning = {
            code: validation.code,
            message: validation.message
          };
        }
      }

      let reverseDependencyWarning: ModuleMatrixRow["reverseDependencyWarning"] =
        null;
      if (tenantState.tenantEnabled && descriptor) {
        const reverseDependencies = allDescriptors
          .filter(
            (d) =>
              d.key !== entry.moduleKey &&
              d.dependencies.includes(entry.moduleKey)
          )
          .map((d) => ({
            descriptor: d,
            tenantState: resolveTenantState(d.key)
          }));

        const validation = evaluateModuleDisable({
          target: descriptor,
          targetTenantState: tenantState,
          reverseDependencies
        });

        if (
          !validation.valid &&
          validation.code === "MODULE_REVERSE_DEPENDENCY_ACTIVE"
        ) {
          reverseDependencyWarning = {
            code: validation.code,
            message: validation.message
          };
        }
      }

      const healthStatus = options.includeHealth
        ? ((
            await fetchModuleHealthReport(
              tx,
              tenantId,
              entry.moduleKey,
              options.correlationId ?? undefined
            )
          )?.status ?? null)
        : null;

      return {
        moduleKey: entry.moduleKey,
        name: entry.name,
        version: entry.version,
        type: entry.type,
        status: entry.status,
        isCore: entry.isCore,
        isProtected: protectedKeys.has(entry.moduleKey),
        tenantEnabled: tenantState.tenantEnabled,
        disableReason: tenantEntry?.disableReason ?? null,
        dependencies: entry.dependencies,
        healthStatus,
        dependencyWarning,
        reverseDependencyWarning
      };
    })
  );
}
