const DEFAULT_PERMISSION_GROUPS = {
  admin: [
    {
      id: "perm_admin_users_read",
      code: "admin.users.read",
      resource: "users",
      action: "read",
      description: "View user accounts and governance metadata.",
      is_protected: false,
    },
    {
      id: "perm_admin_users_invite",
      code: "admin.users.invite",
      resource: "users",
      action: "invite",
      description: "Invite new users into the backoffice.",
      is_protected: false,
    },
    {
      id: "perm_admin_users_update",
      code: "admin.users.update",
      resource: "users",
      action: "update",
      description: "Update user identity and governance profile fields.",
      is_protected: false,
    },
    {
      id: "perm_admin_users_disable",
      code: "admin.users.disable",
      resource: "users",
      action: "disable",
      description: "Disable or lock managed user accounts.",
      is_protected: true,
    },
    {
      id: "perm_admin_roles_read",
      code: "admin.roles.read",
      resource: "roles",
      action: "read",
      description: "View role catalog entries and staff levels.",
      is_protected: false,
    },
    {
      id: "perm_admin_roles_assign",
      code: "admin.roles.assign",
      resource: "roles",
      action: "assign",
      description: "Assign and revoke user role memberships.",
      is_protected: true,
    },
    {
      id: "perm_admin_permissions_read",
      code: "admin.permissions.read",
      resource: "permissions",
      action: "read",
      description: "View the explicit permission catalog and matrix.",
      is_protected: false,
    },
    {
      id: "perm_admin_permissions_update",
      code: "admin.permissions.update",
      resource: "permissions",
      action: "update",
      description: "Change role-to-permission mappings.",
      is_protected: true,
    },
  ],
  audit: [
    {
      id: "perm_audit_logs_read",
      code: "audit.logs.read",
      resource: "logs",
      action: "read",
      description: "Read operational and governance audit logs.",
      is_protected: false,
    },
    {
      id: "perm_audit_logs_export",
      code: "audit.logs.export",
      resource: "logs",
      action: "export",
      description: "Export audit logs for review workflows.",
      is_protected: true,
    },
  ],
  content: [
    {
      id: "perm_content_posts_read",
      code: "content.posts.read",
      resource: "posts",
      action: "read",
      description: "View managed content records.",
      is_protected: false,
    },
    {
      id: "perm_content_posts_create",
      code: "content.posts.create",
      resource: "posts",
      action: "create",
      description: "Create new content items.",
      is_protected: false,
    },
    {
      id: "perm_content_posts_update",
      code: "content.posts.update",
      resource: "posts",
      action: "update",
      description: "Edit existing content items.",
      is_protected: false,
    },
    {
      id: "perm_content_posts_publish",
      code: "content.posts.publish",
      resource: "posts",
      action: "publish",
      description: "Publish content to the site.",
      is_protected: false,
    },
  ],
  governance: [
    {
      id: "perm_governance_jobs_read",
      code: "governance.jobs.read",
      resource: "jobs",
      action: "read",
      description: "View job hierarchy and assignments.",
      is_protected: false,
    },
    {
      id: "perm_governance_jobs_assign",
      code: "governance.jobs.assign",
      resource: "jobs",
      action: "assign",
      description: "Assign and update user job relationships.",
      is_protected: false,
    },
    {
      id: "perm_governance_regions_read",
      code: "governance.regions.read",
      resource: "regions",
      action: "read",
      description: "View logical region definitions and scopes.",
      is_protected: false,
    },
    {
      id: "perm_governance_administrative_regions_assign",
      code: "governance.administrative_regions.assign",
      resource: "administrative_regions",
      action: "assign",
      description: "Assign administrative region scope to managed users.",
      is_protected: false,
    },
  ],
  plugins: [
    {
      id: "perm_plugins_manage_read",
      code: "plugins.manage.read",
      resource: "manage",
      action: "read",
      description: "Inspect installed plugin state and capabilities.",
      is_protected: false,
    },
    {
      id: "perm_plugins_manage_update",
      code: "plugins.manage.update",
      resource: "manage",
      action: "update",
      description: "Enable, disable, or update trusted plugin configuration.",
      is_protected: true,
    },
  ],
  security: [
    {
      id: "perm_security_sessions_read",
      code: "security.sessions.read",
      resource: "sessions",
      action: "read",
      description: "Inspect active and historical session records.",
      is_protected: false,
    },
    {
      id: "perm_security_sessions_revoke",
      code: "security.sessions.revoke",
      resource: "sessions",
      action: "revoke",
      description: "Revoke one or more user sessions.",
      is_protected: true,
    },
    {
      id: "perm_security_2fa_read",
      code: "security.2fa.read",
      resource: "2fa",
      action: "read",
      description: "View two-factor authentication status and enrollment state.",
      is_protected: false,
    },
    {
      id: "perm_security_2fa_reset",
      code: "security.2fa.reset",
      resource: "2fa",
      action: "reset",
      description: "Reset two-factor authentication credentials for a user.",
      is_protected: true,
    },
  ],
};

const DEFAULT_PERMISSIONS = Object.entries(DEFAULT_PERMISSION_GROUPS).flatMap(([domain, permissions]) =>
  permissions.map((permission) => ({
    ...permission,
    domain,
  })),
);

export async function up(db) {
  await db.insertInto("permissions").values(DEFAULT_PERMISSIONS).execute();
}

export async function down(db) {
  await db.deleteFrom("permissions").where("id", "in", DEFAULT_PERMISSIONS.map((permission) => permission.id)).execute();
}

export { DEFAULT_PERMISSION_GROUPS, DEFAULT_PERMISSIONS };
