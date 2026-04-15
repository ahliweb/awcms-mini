import { getDatabase } from "../index.mjs";

const ROLE_PERMISSION_COLUMNS = ["role_id", "permission_id", "granted_by_user_id", "granted_at"];

function baseRolePermissionQuery(executor) {
  return executor.selectFrom("role_permissions").select(ROLE_PERMISSION_COLUMNS);
}

function sortIds(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function diffPermissionIds(currentPermissionIds, nextPermissionIds) {
  const current = new Set(currentPermissionIds);
  const next = new Set(nextPermissionIds);

  return {
    currentPermissionIds: sortIds(current),
    nextPermissionIds: sortIds(next),
    addPermissionIds: sortIds([...next].filter((permissionId) => !current.has(permissionId))),
    removePermissionIds: sortIds([...current].filter((permissionId) => !next.has(permissionId))),
    unchangedPermissionIds: sortIds([...next].filter((permissionId) => current.has(permissionId))),
  };
}

export function createRolePermissionRepository(executor = getDatabase()) {
  return {
    async grantPermissionToRole(input) {
      await executor
        .insertInto("role_permissions")
        .values({
          role_id: input.role_id,
          permission_id: input.permission_id,
          granted_by_user_id: input.granted_by_user_id ?? null,
          granted_at: input.granted_at ?? undefined,
        })
        .execute();

      return this.getRolePermission(input.role_id, input.permission_id);
    },

    async revokePermissionFromRole(roleId, permissionId) {
      await executor
        .deleteFrom("role_permissions")
        .where("role_id", "=", roleId)
        .where("permission_id", "=", permissionId)
        .execute();
    },

    async getRolePermission(roleId, permissionId) {
      return baseRolePermissionQuery(executor)
        .where("role_id", "=", roleId)
        .where("permission_id", "=", permissionId)
        .executeTakeFirst();
    },

    async listRolePermissionsByRoleId(roleId) {
      return baseRolePermissionQuery(executor)
        .where("role_id", "=", roleId)
        .orderBy("permission_id", "asc")
        .execute();
    },

    async listRoleIdsByPermissionId(permissionId) {
      const rows = await baseRolePermissionQuery(executor)
        .where("permission_id", "=", permissionId)
        .orderBy("role_id", "asc")
        .execute();

      return rows.map((row) => row.role_id);
    },

    async diffRolePermissionIds(roleId, nextPermissionIds) {
      const currentRows = await this.listRolePermissionsByRoleId(roleId);
      return diffPermissionIds(
        currentRows.map((row) => row.permission_id),
        nextPermissionIds,
      );
    },

    async syncRolePermissionIds(roleId, nextPermissionIds, options = {}) {
      const diff = await this.diffRolePermissionIds(roleId, nextPermissionIds);

      for (const permissionId of diff.removePermissionIds) {
        await this.revokePermissionFromRole(roleId, permissionId);
      }

      for (const permissionId of diff.addPermissionIds) {
        await this.grantPermissionToRole({
          role_id: roleId,
          permission_id: permissionId,
          granted_by_user_id: options.granted_by_user_id ?? null,
          granted_at: options.granted_at,
        });
      }

      return diff;
    },
  };
}

export { ROLE_PERMISSION_COLUMNS, diffPermissionIds };
