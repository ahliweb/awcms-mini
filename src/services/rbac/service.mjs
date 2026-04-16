import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createPermissionRepository } from "../../db/repositories/permissions.mjs";
import { createRolePermissionRepository } from "../../db/repositories/role-permissions.mjs";
import { createRoleRepository } from "../../db/repositories/roles.mjs";
import { createAuditService } from "../audit/service.mjs";

function createRbacServiceDependencies(executor) {
  return {
    roles: createRoleRepository(executor),
    permissions: createPermissionRepository(executor),
    rolePermissions: createRolePermissionRepository(executor),
    audit: createAuditService({ database: executor }),
  };
}

export function createRbacService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async applyPermissionMatrix(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRbacServiceDependencies(trx);
        const diffs = {};

        for (const [roleId, nextPermissionIds] of Object.entries(input.rolePermissionIdsByRoleId)) {
          const role = await deps.roles.getRoleById(roleId, { includeDeleted: true });
          const diff = await deps.rolePermissions.syncRolePermissionIds(roleId, nextPermissionIds, {
            granted_by_user_id: input.actor_user_id ?? null,
          });
          diffs[roleId] = diff;

          const currentPermissions = [];
          const nextPermissions = [];

          for (const permissionId of diff.currentPermissionIds) {
            const permission = await deps.permissions.getPermissionById(permissionId);
            if (permission) currentPermissions.push(permission.code);
          }

          for (const permissionId of diff.nextPermissionIds) {
            const permission = await deps.permissions.getPermissionById(permissionId);
            if (permission) nextPermissions.push(permission.code);
          }

          await deps.audit.append({
            actor_user_id: input.actor_user_id ?? null,
            action: "permission.matrix.apply",
            entity_type: "role",
            entity_id: roleId,
            summary: `Updated permission matrix for role ${role?.slug ?? roleId}.`,
            before_payload: {
              permission_ids: diff.currentPermissionIds,
              permission_codes: currentPermissions,
            },
            after_payload: {
              permission_ids: diff.nextPermissionIds,
              permission_codes: nextPermissions,
            },
            metadata: {
              role_slug: role?.slug ?? null,
              add_permission_ids: diff.addPermissionIds,
              remove_permission_ids: diff.removePermissionIds,
            },
          });
        }

        return diffs;
      });
    },
  };
}
