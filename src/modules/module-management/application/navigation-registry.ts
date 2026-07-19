/**
 * Module admin navigation registry service (Issue #518, epic #510). Reads
 * navigation entries directly from the live code registry (`listModules()`)
 * — never `awcms_mini_module_navigation` — same reasoning as
 * `tenant-module-lifecycle.ts`'s dependency graph: that table only reflects
 * whatever `bun run modules:sync` last wrote, and a sidebar rendered on
 * every single `/admin/*` request must never depend on someone having
 * remembered to run a sync first. This also keeps the per-request cost to
 * exactly one lightweight query (the tenant's disabled-module keys) —
 * `AdminLayout.astro` already renders on every admin request, so this
 * service is deliberately as cheap as `fetchSyncIndicatorActive`.
 */
import { listModules } from "../..";
import { isModuleTenantEnabledByDefault } from "../../_shared/module-contract";
import {
  filterVisibleNavigationEntries,
  type NavigationCandidate
} from "../domain/navigation-registry";

function collectNavigationCandidates(): NavigationCandidate[] {
  return listModules().flatMap((descriptor) =>
    (descriptor.navigation ?? []).map((entry) => ({
      moduleKey: descriptor.key,
      moduleStatus: descriptor.status,
      labelKey: entry.labelKey,
      path: entry.path,
      icon: entry.icon,
      order: entry.order ?? 0,
      group: entry.group,
      requiredPermission: entry.requiredPermission
    }))
  );
}

async function fetchTenantDisabledModuleKeys(
  tx: Bun.SQL,
  tenantId: string
): Promise<Set<string>> {
  const rows = (await tx`
    SELECT module_key, enabled FROM awcms_mini_tenant_modules
    WHERE tenant_id = ${tenantId}
  `) as { module_key: string; enabled: boolean }[];

  const explicitState = new Map(
    rows.map((row) => [row.module_key, row.enabled])
  );
  const disabled = new Set<string>();

  for (const [moduleKey, enabled] of explicitState) {
    if (!enabled) {
      disabled.add(moduleKey);
    }
  }

  // A `defaultTenantState: "disabled"` control-plane module (Issue #870,
  // ADR-0022 §7) with NO explicit `enabled = true` row is disabled here too —
  // at parity with `resolveModuleEnabled` (route) and the SSR permission gate,
  // so its nav entry never shows for a tenant that has not opted in, even if
  // that entry lacked a `requiredPermission`.
  for (const descriptor of listModules()) {
    if (
      !isModuleTenantEnabledByDefault(descriptor) &&
      explicitState.get(descriptor.key) !== true
    ) {
      disabled.add(descriptor.key);
    }
  }

  return disabled;
}

/**
 * Every module-declared nav entry currently visible to this caller —
 * filtered by module status, tenant module enablement, and the entry's own
 * `requiredPermission` (see `domain/navigation-registry.ts` for the exact
 * rules). Callers append this to whatever fallback nav items they already
 * render unconditionally (`AdminLayout.astro` keeps Dashboard/Access &
 * Users/Sync/Settings exactly as before) — a failure here must never hide
 * those.
 */
export async function fetchVisibleModuleNavigationEntries(
  tx: Bun.SQL,
  tenantId: string,
  grantedPermissionKeys: ReadonlySet<string>
): Promise<NavigationCandidate[]> {
  const tenantDisabledModuleKeys = await fetchTenantDisabledModuleKeys(
    tx,
    tenantId
  );

  return filterVisibleNavigationEntries(collectNavigationCandidates(), {
    grantedPermissionKeys,
    tenantDisabledModuleKeys
  });
}
