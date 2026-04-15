import { getDatabase, withTransaction } from "../../db/index.mjs";
import { normalizePermission } from "../../db/repositories/permissions.mjs";
import { normalizeRole } from "../../db/repositories/roles.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import {
  createAuthorizationCacheEntry,
  createAuthorizationCacheKey,
  createNoopAuthorizationCache,
  isAuthorizationCacheEntryFresh,
} from "../authorization/cache.mjs";

const USER_ROLE_COLUMNS = [
  "id",
  "user_id",
  "role_id",
  "assigned_by_user_id",
  "assigned_at",
  "expires_at",
  "is_primary",
];

const ROLE_PERMISSION_COLUMNS = ["role_id", "permission_id", "granted_by_user_id", "granted_at"];

const PERMISSION_COLUMNS = [
  "id",
  "code",
  "domain",
  "resource",
  "action",
  "description",
  "is_protected",
  "created_at",
];

const ROLE_COLUMNS = [
  "id",
  "slug",
  "name",
  "description",
  "staff_level",
  "is_system",
  "is_assignable",
  "is_protected",
  "deleted_at",
  "deleted_by_user_id",
  "delete_reason",
  "created_at",
  "updated_at",
];

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeUserRole(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_primary: normalizeBoolean(row.is_primary),
  };
}

async function listActiveUserRoles(executor, userId) {
  const rows = await executor
    .selectFrom("user_roles")
    .select(USER_ROLE_COLUMNS)
    .where("user_id", "=", userId)
    .where("expires_at", "is", null)
    .orderBy("is_primary", "desc")
    .orderBy("assigned_at", "desc")
    .orderBy("id", "asc")
    .execute();

  return rows.map(normalizeUserRole);
}

async function listRolePermissions(executor, roleIds) {
  if (roleIds.length === 0) {
    return [];
  }

  const rows = await executor.selectFrom("role_permissions").select(ROLE_PERMISSION_COLUMNS).execute();
  const roleIdSet = new Set(roleIds);

  return rows
    .filter((row) => roleIdSet.has(row.role_id))
    .sort((left, right) => left.role_id.localeCompare(right.role_id) || left.permission_id.localeCompare(right.permission_id));
}

async function listRolesByIds(executor, roleIds) {
  if (roleIds.length === 0) {
    return [];
  }

  const rows = await executor.selectFrom("roles").select(ROLE_COLUMNS).execute();
  const roleIdSet = new Set(roleIds);

  return rows
    .filter((row) => roleIdSet.has(row.id) && row.deleted_at === null)
    .map(normalizeRole)
    .sort((left, right) => right.staff_level - left.staff_level || left.slug.localeCompare(right.slug));
}

async function listPermissionsByIds(executor, permissionIds) {
  if (permissionIds.length === 0) {
    return [];
  }

  const rows = await executor.selectFrom("permissions").select(PERMISSION_COLUMNS).execute();
  const permissionIdSet = new Set(permissionIds);

  return rows
    .filter((row) => permissionIdSet.has(row.id))
    .map(normalizePermission)
    .sort((left, right) => left.code.localeCompare(right.code));
}

async function resolveEffectivePermissions(executor, userId) {
  const users = createUserRepository(executor);
  const user = await users.getUserById(userId, { includeDeleted: true });
  const resolvedAt = new Date().toISOString();

  if (!user || user.deleted_at || user.status === "deleted") {
    return {
      user_id: userId,
      assignments: [],
      roles: [],
      permissions: [],
      permission_codes: [],
      resolved_at: resolvedAt,
      cache_hit: false,
    };
  }

  const assignments = await listActiveUserRoles(executor, userId);
  const roleIds = [...new Set(assignments.map((assignment) => assignment.role_id))];
  const roles = await listRolesByIds(executor, roleIds);
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const assignmentEntries = assignments
    .map((assignment) => ({
      ...assignment,
      role: rolesById.get(assignment.role_id),
    }))
    .filter((assignment) => assignment.role);

  const rolePermissions = await listRolePermissions(executor, [...rolesById.keys()]);
  const permissionIds = [...new Set(rolePermissions.map((entry) => entry.permission_id))];
  const permissions = await listPermissionsByIds(executor, permissionIds);

  return {
    user_id: userId,
    assignments: assignmentEntries,
    roles,
    permissions,
    permission_codes: permissions.map((permission) => permission.code),
    resolved_at: resolvedAt,
    cache_hit: false,
  };
}

export function createPermissionResolutionService(options = {}) {
  const database = options.database ?? getDatabase();
  const hooks = options.hooks ?? {};
  const cache = options.cache ?? createNoopAuthorizationCache();

  return {
    async getEffectivePermissions(userId) {
      const cacheKey = createAuthorizationCacheKey({
        scope: "effective_permissions",
        user_id: userId,
      });

      const cacheEntry = await cache.get(cacheKey);

      if (isAuthorizationCacheEntryFresh(cacheEntry)) {
        return {
          ...cacheEntry.value,
          cache_hit: true,
        };
      }

      if (typeof hooks.getCachedPermissions === "function") {
        const cached = await hooks.getCachedPermissions({ user_id: userId });

        if (cached) {
          return {
            ...cached,
            cache_hit: true,
          };
        }
      }

      const resolved = await withTransaction(database, async (trx) => resolveEffectivePermissions(trx, userId));

      await cache.set(cacheKey, createAuthorizationCacheEntry(resolved));

      if (typeof hooks.storeResolvedPermissions === "function") {
        await hooks.storeResolvedPermissions(resolved);
      }

      return resolved;
    },
  };
}
