import { definePlugin, PluginRouteError } from "emdash";

import { getDatabase } from "../../db/index.mjs";
import { createRolePermissionRepository } from "../../db/repositories/role-permissions.mjs";
import { createUserService } from "../../services/users/service.mjs";

let userAdminDatabaseGetter = () => getDatabase();
let userAdminServiceFactory = (database) => createUserService({ database });

function normalizeProfileRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    lastLoginAt: row.last_login_at,
    mustResetPassword: Boolean(row.must_reset_password),
    isProtected: Boolean(row.is_protected),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profile: {
      phone: row.profile_phone,
      timezone: row.profile_timezone,
      locale: row.profile_locale,
      notes: row.profile_notes,
      avatarMediaId: row.profile_avatar_media_id,
      createdAt: row.profile_created_at,
      updatedAt: row.profile_updated_at,
    },
    activeSessionCount: Number(row.active_session_count ?? 0),
  };
}

function normalizeRoleRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    staffLevel: Number(row.staff_level),
    isSystem: Boolean(row.is_system),
    isAssignable: Boolean(row.is_assignable),
    isProtected: Boolean(row.is_protected),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeAssignmentCount: Number(row.active_assignment_count ?? 0),
  };
}

function normalizeMatrixRoleRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    staffLevel: Number(row.staff_level),
    isAssignable: Boolean(row.is_assignable),
    isProtected: Boolean(row.is_protected),
  };
}

function normalizeMatrixPermissionRow(row, roles, grantedRoleIds) {
  if (!row) {
    return null;
  }

  const granted = new Set(grantedRoleIds);

  return {
    id: row.id,
    code: row.code,
    domain: row.domain,
    resource: row.resource,
    action: row.action,
    description: row.description,
    isProtected: Boolean(row.is_protected),
    grantsByRoleId: Object.fromEntries(roles.map((role) => [role.id, granted.has(role.id)])),
  };
}

async function loadPermissionMatrixSnapshot(db) {
  const roles = (await db
    .selectFrom("roles")
    .select(["id", "slug", "name", "staff_level", "is_assignable", "is_protected", "deleted_at"])
    .where("deleted_at", "is", null)
    .orderBy("staff_level", "desc")
    .orderBy("slug", "asc")
    .execute())
    .map(normalizeMatrixRoleRow);

  const permissions = await db
    .selectFrom("permissions")
    .select(["id", "code", "domain", "resource", "action", "description", "is_protected"])
    .orderBy("domain", "asc")
    .orderBy("code", "asc")
    .execute();

  const rolePermissions = await db
    .selectFrom("role_permissions")
    .select(["role_id", "permission_id"])
    .execute();

  const grantedRoleIdsByPermissionId = new Map();

  for (const entry of rolePermissions) {
    if (!grantedRoleIdsByPermissionId.has(entry.permission_id)) {
      grantedRoleIdsByPermissionId.set(entry.permission_id, []);
    }

    grantedRoleIdsByPermissionId.get(entry.permission_id).push(entry.role_id);
  }

  return {
    roles,
    rows: permissions.map((permission) =>
      normalizeMatrixPermissionRow(permission, roles, grantedRoleIdsByPermissionId.get(permission.id) ?? []),
    ),
  };
}

async function listPermissionMatrixHandler() {
  return loadPermissionMatrixSnapshot(userAdminDatabaseGetter());
}

function parseMatrixBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw PluginRouteError.badRequest("Expected JSON object body");
  }

  const matrix = body.rolePermissionIdsByRoleId;

  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw PluginRouteError.badRequest("Expected rolePermissionIdsByRoleId map");
  }

  return {
    confirmProtectedChanges: body.confirmProtectedChanges === true,
    rolePermissionIdsByRoleId: matrix,
  };
}

async function applyPermissionMatrixHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const parsed = parseMatrixBody(body);
  const db = userAdminDatabaseGetter();
  const snapshot = await loadPermissionMatrixSnapshot(db);
  const validRoleIds = new Set(snapshot.roles.map((role) => role.id));
  const validPermissionIds = new Set(snapshot.rows.map((row) => row.id));
  const currentByRoleId = Object.fromEntries(snapshot.roles.map((role) => [role.id, []]));

  for (const row of snapshot.rows) {
    for (const role of snapshot.roles) {
      if (row.grantsByRoleId[role.id]) {
        currentByRoleId[role.id].push(row.id);
      }
    }
  }

  const nextByRoleId = {};

  for (const role of snapshot.roles) {
    const rawPermissionIds = parsed.rolePermissionIdsByRoleId[role.id] ?? currentByRoleId[role.id];

    if (!Array.isArray(rawPermissionIds)) {
      throw PluginRouteError.badRequest(`Expected permission id array for role ${role.id}`);
    }

    nextByRoleId[role.id] = [...new Set(rawPermissionIds.map((value) => String(value)))];

    for (const permissionId of nextByRoleId[role.id]) {
      if (!validPermissionIds.has(permissionId)) {
        throw PluginRouteError.badRequest(`Unknown permission id: ${permissionId}`);
      }
    }
  }

  for (const roleId of Object.keys(parsed.rolePermissionIdsByRoleId)) {
    if (!validRoleIds.has(roleId)) {
      throw PluginRouteError.badRequest(`Unknown role id: ${roleId}`);
    }
  }

  const protectedChangeCount = snapshot.rows.reduce((count, row) => {
    if (!row.isProtected) {
      return count;
    }

    const changed = snapshot.roles.some((role) => {
      const current = row.grantsByRoleId[role.id] === true;
      const next = nextByRoleId[role.id].includes(row.id);
      return current !== next;
    });

    return changed ? count + 1 : count;
  }, 0);

  if (protectedChangeCount > 0 && parsed.confirmProtectedChanges !== true) {
    throw PluginRouteError.badRequest("Protected permission changes require explicit confirmation.");
  }

  const repo = createRolePermissionRepository(db);
  const diffs = {};

  for (const role of snapshot.roles) {
    diffs[role.id] = await repo.syncRolePermissionIds(role.id, nextByRoleId[role.id]);
  }

  return {
    applied: true,
    protectedChangeCount,
    diffs,
    snapshot: await loadPermissionMatrixSnapshot(db),
  };
}

async function getUserSummaryRow(db, userId) {
  return db
    .selectFrom("users")
    .leftJoin("user_profiles", (join) =>
      join.onRef("user_profiles.user_id", "=", "users.id").on("user_profiles.deleted_at", "is", null),
    )
    .leftJoin("sessions", (join) =>
      join.onRef("sessions.user_id", "=", "users.id").on("sessions.revoked_at", "is", null),
    )
    .select([
      "users.id as id",
      "users.email as email",
      "users.username as username",
      "users.display_name as display_name",
      "users.status as status",
      "users.last_login_at as last_login_at",
      "users.must_reset_password as must_reset_password",
      "users.is_protected as is_protected",
      "users.deleted_at as deleted_at",
      "users.created_at as created_at",
      "users.updated_at as updated_at",
      "user_profiles.phone as profile_phone",
      "user_profiles.timezone as profile_timezone",
      "user_profiles.locale as profile_locale",
      "user_profiles.notes as profile_notes",
      "user_profiles.avatar_media_id as profile_avatar_media_id",
      "user_profiles.created_at as profile_created_at",
      "user_profiles.updated_at as profile_updated_at",
      (eb) => eb.fn.count("sessions.id").as("active_session_count"),
    ])
    .where("users.id", "=", userId)
    .groupBy([
      "users.id",
      "users.email",
      "users.username",
      "users.display_name",
      "users.status",
      "users.last_login_at",
      "users.must_reset_password",
      "users.is_protected",
      "users.deleted_at",
      "users.created_at",
      "users.updated_at",
      "user_profiles.phone",
      "user_profiles.timezone",
      "user_profiles.locale",
      "user_profiles.notes",
      "user_profiles.avatar_media_id",
      "user_profiles.created_at",
      "user_profiles.updated_at",
    ])
    .executeTakeFirst();
}

async function listUsersHandler(ctx) {
  const db = userAdminDatabaseGetter();
  const search = new URL(ctx.request.url).searchParams;
  const limit = Number.parseInt(search.get("limit") ?? "25", 10);
  const includeDeleted = search.get("includeDeleted") === "true";
  const status = search.get("status") ?? undefined;

  let query = db
    .selectFrom("users")
    .leftJoin("user_profiles", (join) =>
      join.onRef("user_profiles.user_id", "=", "users.id").on("user_profiles.deleted_at", "is", null),
    )
    .leftJoin("sessions", (join) =>
      join.onRef("sessions.user_id", "=", "users.id").on("sessions.revoked_at", "is", null),
    )
    .select([
      "users.id as id",
      "users.email as email",
      "users.username as username",
      "users.display_name as display_name",
      "users.status as status",
      "users.last_login_at as last_login_at",
      "users.must_reset_password as must_reset_password",
      "users.is_protected as is_protected",
      "users.deleted_at as deleted_at",
      "users.created_at as created_at",
      "users.updated_at as updated_at",
      "user_profiles.phone as profile_phone",
      "user_profiles.timezone as profile_timezone",
      "user_profiles.locale as profile_locale",
      "user_profiles.notes as profile_notes",
      "user_profiles.avatar_media_id as profile_avatar_media_id",
      "user_profiles.created_at as profile_created_at",
      "user_profiles.updated_at as profile_updated_at",
      (eb) => eb.fn.count("sessions.id").as("active_session_count"),
    ])
    .orderBy("users.created_at", "desc")
    .orderBy("users.email", "asc");

  if (!includeDeleted) {
    query = query.where("users.deleted_at", "is", null);
  }

  if (status) {
    query = query.where("users.status", "=", status);
  }

  const rows = await query
    .groupBy([
      "users.id",
      "users.email",
      "users.username",
      "users.display_name",
      "users.status",
      "users.last_login_at",
      "users.must_reset_password",
      "users.is_protected",
      "users.deleted_at",
      "users.created_at",
      "users.updated_at",
      "user_profiles.phone",
      "user_profiles.timezone",
      "user_profiles.locale",
      "user_profiles.notes",
      "user_profiles.avatar_media_id",
      "user_profiles.created_at",
      "user_profiles.updated_at",
    ])
    .limit(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25)
    .execute();

  return {
    items: rows.map(normalizeProfileRow),
  };
}

async function getUserDetailHandler(ctx) {
  const db = userAdminDatabaseGetter();
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("id");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const row = await getUserSummaryRow(db, userId);

  if (!row) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  return {
    item: normalizeProfileRow(row),
  };
}

async function listRolesHandler(ctx) {
  const db = userAdminDatabaseGetter();
  const search = new URL(ctx.request.url).searchParams;
  const limit = Number.parseInt(search.get("limit") ?? "50", 10);
  const includeDeleted = search.get("includeDeleted") === "true";

  let query = db
    .selectFrom("roles")
    .leftJoin("user_roles", (join) =>
      join.onRef("user_roles.role_id", "=", "roles.id").on("user_roles.expires_at", "is", null),
    )
    .select([
      "roles.id as id",
      "roles.slug as slug",
      "roles.name as name",
      "roles.description as description",
      "roles.staff_level as staff_level",
      "roles.is_system as is_system",
      "roles.is_assignable as is_assignable",
      "roles.is_protected as is_protected",
      "roles.deleted_at as deleted_at",
      "roles.created_at as created_at",
      "roles.updated_at as updated_at",
      (eb) => eb.fn.count("user_roles.id").as("active_assignment_count"),
    ])
    .orderBy("roles.staff_level", "desc")
    .orderBy("roles.slug", "asc");

  if (!includeDeleted) {
    query = query.where("roles.deleted_at", "is", null);
  }

  const rows = await query
    .groupBy([
      "roles.id",
      "roles.slug",
      "roles.name",
      "roles.description",
      "roles.staff_level",
      "roles.is_system",
      "roles.is_assignable",
      "roles.is_protected",
      "roles.deleted_at",
      "roles.created_at",
      "roles.updated_at",
    ])
    .limit(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50)
    .execute();

  return {
    items: rows.map(normalizeRoleRow),
  };
}

async function createInviteHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";

  if (!email) {
    throw PluginRouteError.badRequest("Email is required");
  }

  const users = userAdminServiceFactory(userAdminDatabaseGetter());
  const invite = await users.createInvite({
    email,
    display_name: displayName || null,
  });

  const activationUrl = new URL("/activate", ctx.request.url);
  activationUrl.searchParams.set("token", invite.token);

  return {
    invite: {
      userId: invite.user.id,
      email: invite.user.email,
      expiresAt: invite.expires_at,
      activationUrl: activationUrl.toString(),
    },
  };
}

async function updateLifecycleHandler(ctx, action) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";

  if (!userId) {
    throw PluginRouteError.badRequest("User id is required");
  }

  const users = userAdminServiceFactory(userAdminDatabaseGetter());

  if (action === "disable") {
    await users.disableUser(userId);
  } else if (action === "lock") {
    await users.lockUser(userId);
  } else if (action === "revoke-sessions") {
    await users.revokeUserSessions(userId);
  } else {
    throw PluginRouteError.badRequest(`Unsupported lifecycle action: ${action}`);
  }

  const row = await getUserSummaryRow(userAdminDatabaseGetter(), userId);

  if (!row) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  return {
    item: normalizeProfileRow(row),
  };
}

export function createPlugin() {
  return definePlugin({
    id: "awcms-users-admin",
    version: "0.1.0",
    capabilities: ["read:users"],
    routes: {
      "users/list": {
        handler: listUsersHandler,
      },
      "roles/list": {
        handler: listRolesHandler,
      },
      "permissions/matrix": {
        handler: listPermissionMatrixHandler,
      },
      "permissions/matrix/apply": {
        handler: applyPermissionMatrixHandler,
      },
      "users/detail": {
        handler: getUserDetailHandler,
      },
      "users/invite": {
        handler: createInviteHandler,
      },
      "users/disable": {
        handler: (ctx) => updateLifecycleHandler(ctx, "disable"),
      },
      "users/lock": {
        handler: (ctx) => updateLifecycleHandler(ctx, "lock"),
      },
      "users/revoke-sessions": {
        handler: (ctx) => updateLifecycleHandler(ctx, "revoke-sessions"),
      },
    },
    admin: {
      entry: "/src/plugins/awcms-users-admin/admin.tsx",
      pages: [
        { path: "/", label: "Users", icon: "users" },
        { path: "/roles", label: "Roles", icon: "shield" },
        { path: "/permissions", label: "Permission Matrix", icon: "grid" },
        { path: "/user", label: "User Detail", icon: "user" },
      ],
    },
  });
}

export function awcmsUsersAdminPlugin() {
  return {
    id: "awcms-users-admin",
    version: "0.1.0",
    format: "native",
    entrypoint: "/src/plugins/awcms-users-admin/index.mjs",
    adminEntry: "/src/plugins/awcms-users-admin/admin.tsx",
    adminPages: [
      { path: "/", label: "Users", icon: "users" },
      { path: "/roles", label: "Roles", icon: "shield" },
      { path: "/permissions", label: "Permission Matrix", icon: "grid" },
      { path: "/user", label: "User Detail", icon: "user" },
    ],
  };
}

export function setUserAdminDatabaseGetter(getter) {
  userAdminDatabaseGetter = getter;
}

export function resetUserAdminDatabaseGetter() {
  userAdminDatabaseGetter = () => getDatabase();
}

export function setUserAdminServiceFactory(factory) {
  userAdminServiceFactory = factory;
}

export function resetUserAdminServiceFactory() {
  userAdminServiceFactory = (database) => createUserService({ database });
}

export default createPlugin;
