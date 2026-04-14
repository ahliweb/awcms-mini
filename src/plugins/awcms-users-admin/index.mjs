import { definePlugin, PluginRouteError } from "emdash";

import { getDatabase } from "../../db/index.mjs";

let userAdminDatabaseGetter = () => getDatabase();

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
  };
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
    ])
    .orderBy("users.created_at", "desc")
    .orderBy("users.email", "asc");

  if (!includeDeleted) {
    query = query.where("users.deleted_at", "is", null);
  }

  if (status) {
    query = query.where("users.status", "=", status);
  }

  const rows = await query.limit(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25).execute();

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

  const row = await db
    .selectFrom("users")
    .leftJoin("user_profiles", (join) =>
      join.onRef("user_profiles.user_id", "=", "users.id").on("user_profiles.deleted_at", "is", null),
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
    ])
    .where("users.id", "=", userId)
    .executeTakeFirst();

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
      "users/detail": {
        handler: getUserDetailHandler,
      },
    },
    admin: {
      entry: "/src/plugins/awcms-users-admin/admin.tsx",
      pages: [
        { path: "/", label: "Users", icon: "users" },
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

export default createPlugin;
