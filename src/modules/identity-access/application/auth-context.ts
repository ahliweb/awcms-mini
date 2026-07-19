import { getModuleByKey } from "../..";
import { isModuleTenantEnabledByDefault } from "../../_shared/module-contract";
import type { TenantContext } from "../domain/access-control";
import { resolveActiveSession } from "./session-lookup";

export async function resolveTenantContext(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<TenantContext | null> {
  const session = await resolveActiveSession(tx, tenantId, tokenHash, now);

  if (!session) {
    return null;
  }

  const tenantUserRows = await tx`
    SELECT id, tenant_id
    FROM awcms_mini_tenant_users
    WHERE tenant_id = ${tenantId} AND identity_id = ${session.identity_id}
  `;
  const tenantUser = tenantUserRows[0] as { id: string } | undefined;

  if (!tenantUser) {
    return null;
  }

  const roleRows = await tx`
    SELECT r.role_code
    FROM awcms_mini_access_assignments aa
    JOIN awcms_mini_roles r ON r.id = aa.role_id
    WHERE aa.tenant_id = ${tenantId} AND aa.tenant_user_id = ${tenantUser.id}
      AND r.deleted_at IS NULL
  `;
  const roles = roleRows.map((row: { role_code: string }) => row.role_code);

  return {
    tenantId,
    tenantUserId: tenantUser.id,
    identityId: session.identity_id,
    roles
  };
}

/**
 * Whether `moduleKey` is available for `tenantId` (Issue #515's
 * `awcms_mini_tenant_modules`). This is the RUNTIME guard every guarded API
 * endpoint (and, via the SSR data helpers, every admin page) funnels through
 * — `authorizeInTransaction` calls it before ABAC, so a `false` here blocks
 * the module's ENTIRE surface, not just the UI.
 *
 * No `awcms_mini_tenant_modules` row means "never toggled": the default is
 * `true` (available by default — historical repo-wide behavior) UNLESS the
 * module's descriptor opted into `defaultTenantState: "disabled"` (Issue
 * #870, ADR-0022 §7 — the opt-in SaaS control-plane modules). This is the
 * runtime half of the default-disabled mechanism: for such a module, a tenant
 * that never explicitly enabled it resolves to DISABLED here, so it has no
 * reachable endpoint/SSR surface at all. Enforced by
 * `tests/unit/module-governance-default-disabled.test.ts`.
 */
export async function resolveModuleEnabled(
  tx: Bun.SQL,
  tenantId: string,
  moduleKey: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT enabled FROM awcms_mini_tenant_modules
    WHERE tenant_id = ${tenantId} AND module_key = ${moduleKey}
  `) as { enabled: boolean }[];

  return (
    rows[0]?.enabled ??
    isModuleTenantEnabledByDefault(getModuleByKey(moduleKey))
  );
}

export async function fetchGrantedPermissionKeys(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string
): Promise<Set<string>> {
  const rows = await tx`
    SELECT DISTINCT p.module_key, p.activity_code, p.action
    FROM awcms_mini_access_assignments aa
    JOIN awcms_mini_role_permissions rp ON rp.role_id = aa.role_id AND rp.tenant_id = aa.tenant_id
    JOIN awcms_mini_permissions p ON p.id = rp.permission_id
    JOIN awcms_mini_roles r ON r.id = aa.role_id
    WHERE aa.tenant_id = ${tenantId} AND aa.tenant_user_id = ${tenantUserId}
      AND r.deleted_at IS NULL
  `;

  return new Set(
    rows.map(
      (row: { module_key: string; activity_code: string; action: string }) =>
        `${row.module_key}.${row.activity_code}.${row.action}`
    )
  );
}
