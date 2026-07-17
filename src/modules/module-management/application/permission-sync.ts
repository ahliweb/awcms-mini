/**
 * Module permission sync/status service (Issue #517, epic #510). Read-only:
 * reports whether each module-declared permission is `synced`, `missing`,
 * `orphaned`, or has a `mismatched_description` against
 * `awcms_mini_permissions` — never writes to that table (see
 * `domain/permission-sync.ts`'s doc comment for why the issue's optional
 * sync-write action isn't implemented).
 */
import { listModules } from "../..";
import {
  comparePermissions,
  type CatalogPermission,
  type DescriptorPermission,
  type PermissionSyncEntry
} from "../domain/permission-sync";

type CatalogPermissionRow = {
  module_key: string;
  activity_code: string;
  action: string;
  description: string | null;
};

async function fetchCatalogPermissions(
  tx: Bun.SQL,
  moduleKey?: string
): Promise<CatalogPermission[]> {
  const rows = (
    moduleKey
      ? await tx`
          SELECT module_key, activity_code, action, description
          FROM awcms_mini_permissions
          WHERE module_key = ${moduleKey}
        `
      : await tx`
          SELECT module_key, activity_code, action, description
          FROM awcms_mini_permissions
        `
  ) as CatalogPermissionRow[];

  return rows.map((row) => ({
    moduleKey: row.module_key,
    activityCode: row.activity_code,
    action: row.action,
    description: row.description
  }));
}

function descriptorPermissionsForModule(
  moduleKey: string
): DescriptorPermission[] {
  const descriptor = listModules().find((d) => d.key === moduleKey);

  return (descriptor?.permissions ?? []).map((permission) => ({
    moduleKey,
    activityCode: permission.activityCode,
    action: permission.action,
    description: permission.description
  }));
}

export type ModulePermissionSyncReport = {
  moduleKey: string;
  entries: PermissionSyncEntry[];
};

/**
 * `null` means `moduleKey` is neither a registered descriptor nor present
 * anywhere in the permission catalog — a genuinely unknown key, `404`.
 * A registered module that simply hasn't declared any `permissions` yet
 * (most existing modules — see `module-management/README.md`) still
 * returns a report; every one of its catalog rows shows as `orphaned`,
 * which honestly reflects that its descriptor hasn't been backfilled,
 * not that those permissions are actually abandoned.
 */
export async function fetchModulePermissionSyncReport(
  tx: Bun.SQL,
  moduleKey: string
): Promise<ModulePermissionSyncReport | null> {
  return buildModulePermissionSyncReport(
    moduleKey,
    await fetchCatalogPermissions(tx, moduleKey)
  );
}

/**
 * The pure half of `fetchModulePermissionSyncReport` — same comparison, but
 * fed already-fetched catalog rows instead of running its own query. Exists so
 * a caller reporting on MANY modules at once (`fetchModuleHealthReports`,
 * Issue #824) can pay for one catalog query total instead of one per module,
 * without re-deriving the compare logic.
 */
export function buildModulePermissionSyncReport(
  moduleKey: string,
  catalogPermissions: CatalogPermission[]
): ModulePermissionSyncReport | null {
  const descriptorExists = listModules().some((d) => d.key === moduleKey);

  if (!descriptorExists && catalogPermissions.length === 0) {
    return null;
  }

  const entries = comparePermissions(
    descriptorPermissionsForModule(moduleKey),
    catalogPermissions
  );

  return { moduleKey, entries };
}

/** Whole catalog in ONE query, grouped by module key — the batch feed for `buildModulePermissionSyncReport` (Issue #824). */
export async function fetchCatalogPermissionsByModule(
  tx: Bun.SQL
): Promise<Map<string, CatalogPermission[]>> {
  const byModule = new Map<string, CatalogPermission[]>();

  for (const permission of await fetchCatalogPermissions(tx)) {
    const existing = byModule.get(permission.moduleKey);

    if (existing) {
      existing.push(permission);
    } else {
      byModule.set(permission.moduleKey, [permission]);
    }
  }

  return byModule;
}
