/**
 * Read-side queries shared by the `/api/v1/users`, `/api/v1/roles`,
 * `/api/v1/permissions` endpoints AND the `/admin/access-users` SSR page —
 * same pattern as `modules/reporting/application/*-report.ts` being shared
 * between the reporting endpoints and `admin/index.astro`. Keeping the SQL
 * here means the SSR page never round-trips through its own HTTP API (it
 * calls these directly inside its own `withTenant` transaction), while the
 * JSON endpoints stay the single source of truth for API consumers.
 */

export type TenantUserWithRoles = {
  tenantUserId: string;
  identityId: string;
  profileId: string;
  displayName: string;
  loginIdentifier: string;
  status: "active" | "inactive";
  identityStatus: "active" | "inactive" | "locked";
  lastLoginAt: string | null;
  roles: { roleId: string; roleCode: string; roleName: string }[];
};

type TenantUserRow = {
  tenant_user_id: string;
  tenant_user_status: "active" | "inactive";
  identity_id: string;
  login_identifier: string;
  identity_status: "active" | "inactive" | "locked";
  last_login_at: Date | null;
  display_name: string;
  profile_id: string;
};

type UserRoleRow = {
  tenant_user_id: string;
  role_id: string;
  role_code: string;
  role_name: string;
};

export async function fetchTenantUsersWithRoles(
  tx: Bun.SQL,
  tenantId: string
): Promise<TenantUserWithRoles[]> {
  const userRows = (await tx`
    SELECT tu.id AS tenant_user_id, tu.status AS tenant_user_status,
           i.id AS identity_id, i.login_identifier, i.status AS identity_status,
           i.last_login_at, p.id AS profile_id, p.display_name
    FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i
      ON i.id = tu.identity_id AND i.tenant_id = tu.tenant_id
    JOIN awcms_mini_profiles p
      ON p.id = i.profile_id AND p.tenant_id = tu.tenant_id
    WHERE tu.tenant_id = ${tenantId}
    ORDER BY p.display_name ASC
  `) as TenantUserRow[];

  const roleRows = (await tx`
    SELECT aa.tenant_user_id, r.id AS role_id, r.role_code, r.role_name
    FROM awcms_mini_access_assignments aa
    JOIN awcms_mini_roles r
      ON r.id = aa.role_id AND r.tenant_id = aa.tenant_id
    WHERE aa.tenant_id = ${tenantId} AND r.deleted_at IS NULL
  `) as UserRoleRow[];

  const rolesByUser = new Map<
    string,
    { roleId: string; roleCode: string; roleName: string }[]
  >();

  for (const row of roleRows) {
    const list = rolesByUser.get(row.tenant_user_id) ?? [];
    list.push({
      roleId: row.role_id,
      roleCode: row.role_code,
      roleName: row.role_name
    });
    rolesByUser.set(row.tenant_user_id, list);
  }

  return userRows.map((row) => ({
    tenantUserId: row.tenant_user_id,
    identityId: row.identity_id,
    profileId: row.profile_id,
    displayName: row.display_name,
    loginIdentifier: row.login_identifier,
    status: row.tenant_user_status,
    identityStatus: row.identity_status,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    roles: rolesByUser.get(row.tenant_user_id) ?? []
  }));
}

export type RoleWithPermissions = {
  roleId: string;
  roleCode: string;
  roleName: string;
  isSystem: boolean;
  permissionIds: string[];
  assignedUserCount: number;
  createdAt: string;
};

type RoleRow = {
  id: string;
  role_code: string;
  role_name: string;
  is_system: boolean;
  created_at: Date;
};

export async function fetchRolesWithPermissions(
  tx: Bun.SQL,
  tenantId: string
): Promise<RoleWithPermissions[]> {
  const roleRows = (await tx`
    SELECT id, role_code, role_name, is_system, created_at
    FROM awcms_mini_roles
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    ORDER BY role_name ASC
  `) as RoleRow[];

  const permissionRows = (await tx`
    SELECT role_id, permission_id
    FROM awcms_mini_role_permissions
    WHERE tenant_id = ${tenantId}
  `) as { role_id: string; permission_id: string }[];

  const assignmentRows = (await tx`
    SELECT role_id, count(*)::int AS n
    FROM awcms_mini_access_assignments
    WHERE tenant_id = ${tenantId}
    GROUP BY role_id
  `) as { role_id: string; n: number }[];

  const permsByRole = new Map<string, string[]>();
  for (const row of permissionRows) {
    const list = permsByRole.get(row.role_id) ?? [];
    list.push(row.permission_id);
    permsByRole.set(row.role_id, list);
  }

  const assignmentCountByRole = new Map(
    assignmentRows.map((row) => [row.role_id, row.n])
  );

  return roleRows.map((row) => ({
    roleId: row.id,
    roleCode: row.role_code,
    roleName: row.role_name,
    isSystem: row.is_system,
    permissionIds: permsByRole.get(row.id) ?? [],
    assignedUserCount: assignmentCountByRole.get(row.id) ?? 0,
    createdAt: row.created_at.toISOString()
  }));
}

export type PermissionCatalogEntry = {
  permissionId: string;
  moduleKey: string;
  activityCode: string;
  action: string;
  key: string;
  description: string | null;
};

type PermissionRow = {
  id: string;
  module_key: string;
  activity_code: string;
  action: string;
  description: string | null;
};

export async function fetchPermissionCatalog(
  tx: Bun.SQL
): Promise<PermissionCatalogEntry[]> {
  const rows = (await tx`
    SELECT id, module_key, activity_code, action, description
    FROM awcms_mini_permissions
    ORDER BY module_key, activity_code, action
  `) as PermissionRow[];

  return rows.map((row) => ({
    permissionId: row.id,
    moduleKey: row.module_key,
    activityCode: row.activity_code,
    action: row.action,
    key: `${row.module_key}.${row.activity_code}.${row.action}`,
    description: row.description ?? null
  }));
}
