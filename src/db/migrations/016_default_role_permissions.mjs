import { DEFAULT_PERMISSIONS } from "./014_default_permissions.mjs";
import { DEFAULT_ROLES } from "./015_default_roles.mjs";

const ROLE_PERMISSION_CODES = {
  owner: DEFAULT_PERMISSIONS.map((permission) => permission.code),
  super_admin: DEFAULT_PERMISSIONS.map((permission) => permission.code),
  admin: [
    "admin.users.read",
    "admin.users.invite",
    "admin.users.update",
    "admin.users.disable",
    "admin.roles.read",
    "admin.roles.assign",
    "admin.permissions.read",
    "admin.permissions.update",
    "audit.logs.read",
    "content.posts.read",
    "content.posts.create",
    "content.posts.update",
    "content.posts.publish",
    "governance.jobs.read",
    "governance.jobs.assign",
    "governance.regions.read",
    "governance.administrative_regions.assign",
    "plugins.manage.read",
    "plugins.manage.update",
    "security.sessions.read",
  ],
  security_admin: [
    "admin.users.read",
    "admin.users.update",
    "admin.users.disable",
    "admin.roles.read",
    "admin.permissions.read",
    "audit.logs.read",
    "audit.logs.export",
    "security.sessions.read",
    "security.sessions.revoke",
    "security.2fa.read",
    "security.2fa.reset",
  ],
  region_manager: [
    "admin.users.read",
    "governance.jobs.read",
    "governance.jobs.assign",
    "governance.regions.read",
    "governance.administrative_regions.assign",
  ],
  editor: [
    "content.posts.read",
    "content.posts.create",
    "content.posts.update",
    "content.posts.publish",
  ],
  auditor: [
    "admin.permissions.read",
    "audit.logs.read",
    "audit.logs.export",
    "governance.jobs.read",
    "governance.regions.read",
    "security.sessions.read",
    "security.2fa.read",
  ],
  author: [
    "content.posts.read",
    "content.posts.create",
    "content.posts.update",
  ],
  contributor: [
    "content.posts.read",
    "content.posts.create",
    "content.posts.update",
  ],
  member: [
    "content.posts.read",
  ],
  viewer: [
    "content.posts.read",
  ],
};

const roleIdBySlug = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.slug, role.id]));
const permissionIdByCode = Object.fromEntries(DEFAULT_PERMISSIONS.map((permission) => [permission.code, permission.id]));

const DEFAULT_ROLE_PERMISSIONS = Object.entries(ROLE_PERMISSION_CODES).flatMap(([roleSlug, permissionCodes]) =>
  permissionCodes.map((permissionCode) => ({
    role_id: roleIdBySlug[roleSlug],
    permission_id: permissionIdByCode[permissionCode],
    granted_by_user_id: null,
  })),
);

export async function up(db) {
  await db.insertInto("role_permissions").values(DEFAULT_ROLE_PERMISSIONS).execute();
}

export async function down(db) {
  for (const entry of DEFAULT_ROLE_PERMISSIONS) {
    await db
      .deleteFrom("role_permissions")
      .where("role_id", "=", entry.role_id)
      .where("permission_id", "=", entry.permission_id)
      .execute();
  }
}

export { DEFAULT_ROLE_PERMISSIONS, ROLE_PERMISSION_CODES };
