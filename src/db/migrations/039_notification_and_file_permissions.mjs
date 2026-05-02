const PERMISSIONS = [
  {
    id: "perm_files_upload",
    code: "files.upload",
    domain: "files",
    resource: "objects",
    action: "upload",
    description: "Request and complete protected file uploads.",
    is_protected: false,
  },
  {
    id: "perm_files_read",
    code: "files.read",
    domain: "files",
    resource: "objects",
    action: "read",
    description: "Read protected file metadata and signed URLs.",
    is_protected: false,
  },
  {
    id: "perm_files_delete",
    code: "files.delete",
    domain: "files",
    resource: "objects",
    action: "delete",
    description: "Delete managed file objects.",
    is_protected: true,
  },
  {
    id: "perm_notifications_send",
    code: "notifications.send",
    domain: "notifications",
    resource: "dispatch",
    action: "send",
    description: "Dispatch outbound email and WhatsApp notifications.",
    is_protected: true,
  },
  {
    id: "perm_notifications_read",
    code: "notifications.read",
    domain: "notifications",
    resource: "requests",
    action: "read",
    description: "Read outbound notification requests.",
    is_protected: false,
  },
  {
    id: "perm_notifications_manage_templates",
    code: "notifications.manage_templates",
    domain: "notifications",
    resource: "templates",
    action: "manage",
    description: "Create and manage message templates.",
    is_protected: true,
  },
  {
    id: "perm_notifications_read_delivery_logs",
    code: "notifications.read_delivery_logs",
    domain: "notifications",
    resource: "delivery_logs",
    action: "read",
    description: "Inspect provider delivery attempts and statuses.",
    is_protected: false,
  },
  {
    id: "perm_integrations_mailketing_manage",
    code: "integrations.mailketing.manage",
    domain: "integrations",
    resource: "mailketing",
    action: "manage",
    description: "Manage Mailketing integration behavior.",
    is_protected: true,
  },
  {
    id: "perm_integrations_starsender_manage",
    code: "integrations.starsender.manage",
    domain: "integrations",
    resource: "starsender",
    action: "manage",
    description: "Manage Starsender integration behavior.",
    is_protected: true,
  },
];

const ROLE_GRANTS = {
  role_owner: PERMISSIONS.map((permission) => permission.id),
  role_super_admin: PERMISSIONS.map((permission) => permission.id),
  role_admin: [
    "perm_files_upload",
    "perm_files_read",
    "perm_notifications_send",
    "perm_notifications_read",
    "perm_notifications_manage_templates",
    "perm_notifications_read_delivery_logs",
    "perm_integrations_mailketing_manage",
    "perm_integrations_starsender_manage",
  ],
  role_security_admin: [
    "perm_files_read",
    "perm_notifications_read",
    "perm_notifications_read_delivery_logs",
  ],
  role_auditor: [
    "perm_notifications_read",
    "perm_notifications_read_delivery_logs",
  ],
};

function buildRolePermissionRows() {
  return Object.entries(ROLE_GRANTS).flatMap(([roleId, permissionIds]) =>
    permissionIds.map((permissionId) => ({
      role_id: roleId,
      permission_id: permissionId,
      granted_by_user_id: null,
    })),
  );
}

const ROLE_PERMISSION_ROWS = buildRolePermissionRows();

export async function up(db) {
  await db
    .insertInto("permissions")
    .values(PERMISSIONS)
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();

  await db
    .insertInto("role_permissions")
    .values(ROLE_PERMISSION_ROWS)
    .onConflict((conflict) => conflict.columns(["role_id", "permission_id"]).doNothing())
    .execute();
}

export async function down(db) {
  for (const row of ROLE_PERMISSION_ROWS) {
    await db
      .deleteFrom("role_permissions")
      .where("role_id", "=", row.role_id)
      .where("permission_id", "=", row.permission_id)
      .execute();
  }

  await db
    .deleteFrom("permissions")
    .where(
      "id",
      "in",
      PERMISSIONS.map((permission) => permission.id),
    )
    .execute();
}
