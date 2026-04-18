import { DEFAULT_PERMISSIONS } from "./014_default_permissions.mjs";
import { DEFAULT_ROLES } from "./015_default_roles.mjs";

const EDGE_API_PERMISSIONS = [
  {
    id: "perm_edge_api_session_read",
    code: "edge.api.session.read",
    domain: "edge",
    resource: "api_session",
    action: "read",
    description: "Inspect the authenticated caller's current edge API session state.",
    is_protected: false,
  },
  {
    id: "perm_edge_api_session_revoke",
    code: "edge.api.session.revoke",
    domain: "edge",
    resource: "api_session",
    action: "revoke",
    description: "Revoke the authenticated caller's current edge API session.",
    is_protected: false,
  },
];

const roleIdBySlug = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.slug, role.id]));
const permissionIdByCode = Object.fromEntries([...DEFAULT_PERMISSIONS, ...EDGE_API_PERMISSIONS].map((permission) => [permission.code, permission.id]));

const EDGE_API_ROLE_PERMISSION_CODES = {
  owner: ["edge.api.session.read", "edge.api.session.revoke"],
  super_admin: ["edge.api.session.read", "edge.api.session.revoke"],
  admin: ["edge.api.session.read", "edge.api.session.revoke"],
  security_admin: ["edge.api.session.read", "edge.api.session.revoke"],
  region_manager: ["edge.api.session.read", "edge.api.session.revoke"],
  editor: ["edge.api.session.read", "edge.api.session.revoke"],
  auditor: ["edge.api.session.read", "edge.api.session.revoke"],
  author: ["edge.api.session.read", "edge.api.session.revoke"],
  contributor: ["edge.api.session.read", "edge.api.session.revoke"],
  member: ["edge.api.session.read", "edge.api.session.revoke"],
  viewer: ["edge.api.session.read", "edge.api.session.revoke"],
};

const EDGE_API_ROLE_PERMISSIONS = Object.entries(EDGE_API_ROLE_PERMISSION_CODES).flatMap(([roleSlug, permissionCodes]) =>
  permissionCodes.map((permissionCode) => ({
    role_id: roleIdBySlug[roleSlug],
    permission_id: permissionIdByCode[permissionCode],
    granted_by_user_id: null,
  })),
);

export async function up(db) {
  await db.insertInto("permissions").values(EDGE_API_PERMISSIONS).execute();
  await db.insertInto("role_permissions").values(EDGE_API_ROLE_PERMISSIONS).execute();
}

export async function down(db) {
  for (const entry of EDGE_API_ROLE_PERMISSIONS) {
    await db
      .deleteFrom("role_permissions")
      .where("role_id", "=", entry.role_id)
      .where("permission_id", "=", entry.permission_id)
      .execute();
  }

  await db.deleteFrom("permissions").where("id", "in", EDGE_API_PERMISSIONS.map((permission) => permission.id)).execute();
}

export { EDGE_API_PERMISSIONS, EDGE_API_ROLE_PERMISSION_CODES, EDGE_API_ROLE_PERMISSIONS };
