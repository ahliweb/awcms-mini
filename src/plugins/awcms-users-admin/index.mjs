import { definePlugin, PluginRouteError } from "emdash";

import { getDatabase } from "../../db/index.mjs";
import { createAdministrativeRegionRepository } from "../../db/repositories/administrative-regions.mjs";
import { createJobLevelRepository } from "../../db/repositories/job-levels.mjs";
import { createJobTitleRepository } from "../../db/repositories/job-titles.mjs";
import { createLoginSecurityEventRepository } from "../../db/repositories/login-security-events.mjs";
import { createRegionRepository } from "../../db/repositories/regions.mjs";
import { createSessionRepository } from "../../db/repositories/sessions.mjs";
import { createUserAdministrativeRegionAssignmentRepository } from "../../db/repositories/user-administrative-region-assignments.mjs";
import { createUserJobRepository } from "../../db/repositories/user-jobs.mjs";
import { createUserRegionAssignmentRepository } from "../../db/repositories/user-region-assignments.mjs";
import { createAdministrativeRegionAssignmentService } from "../../services/administrative-regions/assignments.mjs";
import { createAdminTwoFactorService } from "../../services/security/admin-two-factor.mjs";
import { createAuthorizationService } from "../../services/authorization/service.mjs";
import { createAuditService } from "../../services/audit/service.mjs";
import { createJobsService } from "../../services/jobs/service.mjs";
import { createRbacService } from "../../services/rbac/service.mjs";
import { createRoleAssignmentService } from "../../services/roles/service.mjs";
import { createRegionAssignmentService } from "../../services/regions/assignments.mjs";
import { createRegionService } from "../../services/regions/service.mjs";
import { createSessionService } from "../../services/sessions/service.mjs";
import { createUserService } from "../../services/users/service.mjs";
import { getSecurityPolicy, updateSecurityPolicy } from "../../security/policy.mjs";
import { collectRegisteredPluginPermissions } from "../permission-registration.mjs";

const USER_ADMIN_PERMISSION_DECLARATIONS = [
  { code: "admin.users.read", domain: "admin", resource: "users", action: "read", description: "View user records and profile detail." },
  { code: "admin.users.invite", domain: "admin", resource: "users", action: "invite", description: "Create invited user accounts." },
  { code: "admin.users.disable", domain: "admin", resource: "users", action: "disable", description: "Disable or lock user accounts.", is_protected: true },
  { code: "admin.roles.read", domain: "admin", resource: "roles", action: "read", description: "Inspect role assignments and role metadata." },
  { code: "admin.roles.assign", domain: "admin", resource: "roles", action: "assign", description: "Assign roles to users.", is_protected: true },
  { code: "admin.permissions.read", domain: "admin", resource: "permissions", action: "read", description: "View the explicit permission catalog and matrix." },
  { code: "admin.permissions.update", domain: "admin", resource: "permissions", action: "update", description: "Apply permission matrix changes.", is_protected: true },
  { code: "governance.jobs.read", domain: "governance", resource: "jobs", action: "read", description: "Inspect user job assignments and ladder metadata." },
  { code: "governance.jobs.assign", domain: "governance", resource: "jobs", action: "assign", description: "Assign jobs to users.", is_protected: true },
  { code: "governance.regions.read", domain: "governance", resource: "regions", action: "read", description: "Inspect logical region assignments and hierarchy." },
  { code: "governance.regions.assign", domain: "governance", resource: "regions", action: "assign", description: "Assign logical regions to users.", is_protected: true },
  { code: "governance.administrative_regions.assign", domain: "governance", resource: "administrative_regions", action: "assign", description: "Inspect and assign administrative regions.", is_protected: true },
  { code: "security.2fa.read", domain: "security", resource: "2fa", action: "read", description: "Inspect user two-factor status." },
  { code: "security.2fa.reset", domain: "security", resource: "2fa", action: "reset", description: "Reset a user's two-factor enrollment.", is_protected: true },
  { code: "security.sessions.read", domain: "security", resource: "sessions", action: "read", description: "Inspect active sessions and login history." },
  { code: "security.sessions.revoke", domain: "security", resource: "sessions", action: "revoke", description: "Revoke one or more active sessions.", is_protected: true },
  { code: "audit.logs.read", domain: "audit", resource: "logs", action: "read", description: "View audit log entries." },
];

export const USER_ADMIN_PLUGIN_PERMISSIONS = collectRegisteredPluginPermissions([
  {
    id: "awcms-users-admin",
    permissions: USER_ADMIN_PERMISSION_DECLARATIONS,
  },
]);

let userAdminDatabaseGetter = () => getDatabase();
let userAdminServiceFactory = (database) => createUserService({ database });
let userAdminJobsServiceFactory = (database) => createJobsService({ database });
let userAdminRegionServiceFactory = (database) => createRegionService({ database });
let userAdminRegionAssignmentServiceFactory = (database) => createRegionAssignmentService({ database });
let userAdminAdministrativeRegionAssignmentServiceFactory = (database) => createAdministrativeRegionAssignmentService({ database });
let userAdminAdminTwoFactorServiceFactory = (database) => createAdminTwoFactorService({ database });
let userAdminRbacServiceFactory = (database) => createRbacService({ database });
let userAdminRoleAssignmentServiceFactory = (database) => createRoleAssignmentService({ database });
let userAdminSessionServiceFactory = (database) => createSessionService({ database });
let userAdminAuthorizationServiceFactory = (database) => createAuthorizationService({ database });

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

function normalizeAuthorizationUserRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    isProtected: Boolean(row.is_protected),
    deletedAt: row.deleted_at,
    activeRoleStaffLevel: Number(row.active_role_staff_level ?? 0),
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

function normalizeJobLevelRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    rankOrder: Number(row.rank_order),
    description: row.description,
    isSystem: Boolean(row.is_system),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeTitleCount: Number(row.active_title_count ?? 0),
  };
}

function normalizeJobTitleRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    jobLevelId: row.job_level_id,
    levelCode: row.level_code,
    levelName: row.level_name,
    levelRankOrder: Number(row.level_rank_order),
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: Boolean(row.is_active),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUserJobAssignmentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    jobLevelId: row.job_level_id,
    jobLevelCode: row.job_level_code,
    jobLevelName: row.job_level_name,
    jobLevelRankOrder: Number(row.job_level_rank_order ?? 0),
    jobTitleId: row.job_title_id,
    jobTitleCode: row.job_title_code,
    jobTitleName: row.job_title_name,
    supervisorUserId: row.supervisor_user_id,
    supervisorDisplayName: row.supervisor_display_name,
    employmentStatus: row.employment_status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isPrimary: Boolean(row.is_primary),
    assignedByUserId: row.assigned_by_user_id,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function normalizeRegionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
    level: Number(row.level),
    path: row.path,
    sortOrder: Number(row.sort_order ?? 0),
    isActive: Boolean(row.is_active),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeAdministrativeRegionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    path: row.path,
    provinceCode: row.province_code,
    regencyCode: row.regency_code,
    districtCode: row.district_code,
    villageCode: row.village_code,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUserRoleAssignmentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    roleId: row.role_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at,
    expiresAt: row.expires_at,
    isPrimary: Boolean(row.is_primary),
    role: row.role
      ? {
          id: row.role.id,
          slug: row.role.slug,
          name: row.role.name,
          description: row.role.description,
          staffLevel: Number(row.role.staff_level),
          isSystem: Boolean(row.role.is_system),
          isAssignable: Boolean(row.role.is_assignable),
          isProtected: Boolean(row.role.is_protected),
        }
      : null,
  };
}

function normalizeSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    trustedDevice: Boolean(row.trusted_device),
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function normalizeLoginSecurityEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    emailAttempted: row.email_attempted,
    eventType: row.event_type,
    outcome: row.outcome,
    reason: row.reason,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    occurredAt: row.occurred_at,
  };
}

function normalizeUserRegionAssignmentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    regionId: row.region_id,
    regionCode: row.region_code,
    regionName: row.region_name,
    regionLevel: Number(row.region_level ?? 0),
    regionPath: row.region_path,
    assignmentType: row.assignment_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isPrimary: Boolean(row.is_primary),
    assignedByUserId: row.assigned_by_user_id,
    createdAt: row.created_at,
  };
}

function normalizeUserAdministrativeRegionAssignmentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    administrativeRegionId: row.administrative_region_id,
    administrativeRegionCode: row.administrative_region_code,
    administrativeRegionName: row.administrative_region_name,
    administrativeRegionType: row.administrative_region_type,
    administrativeRegionPath: row.administrative_region_path,
    assignmentType: row.assignment_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isPrimary: Boolean(row.is_primary),
    assignedByUserId: row.assigned_by_user_id,
    createdAt: row.created_at,
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

function normalizeAuditLogRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    targetUserId: row.target_user_id,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    summary: row.summary,
    beforePayload: row.before_payload,
    afterPayload: row.after_payload,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
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

async function resolveAdminActor(db, request) {
  const actorUserId = request.headers.get("x-actor-user-id")?.trim() ?? "";

  if (!actorUserId) {
    throw PluginRouteError.unauthorized("Missing admin actor context.");
  }

  const actor = normalizeAuthorizationUserRow(await getUserSummaryRow(db, actorUserId));

  if (!actor || actor.deletedAt || actor.status === "deleted") {
    throw PluginRouteError.unauthorized("Admin actor is not available.");
  }

  return actor;
}

async function requireAdminAuthorization(ctx, options) {
  const db = userAdminDatabaseGetter();
  const actor = await resolveAdminActor(db, ctx.request);
  const authorization = userAdminAuthorizationServiceFactory(db);
  const result = await authorization.evaluate({
    subject: {
      kind: "user",
      user_id: actor.id,
      status: actor.status,
      is_protected: actor.isProtected,
      staff_level: actor.activeRoleStaffLevel,
    },
    resource: options.resource,
    context: {
      permission_code: options.permissionCode,
      action: options.action,
      session_id: ctx.request.headers.get("x-session-id")?.trim() ?? null,
    },
  });

  if (!result.allowed) {
    throw PluginRouteError.forbidden(result.reason?.code ?? "Forbidden");
  }

  return result;
}

async function listPermissionMatrixHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.permissions.read",
    action: "read",
    resource: {
      kind: "permission",
    },
  });

  return loadPermissionMatrixSnapshot(userAdminDatabaseGetter());
}

async function listAuditLogsHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "audit.logs.read",
    action: "read",
    resource: {
      kind: "audit_log",
    },
  });

  const search = new URL(ctx.request.url).searchParams;
  const limit = Number.parseInt(search.get("limit") ?? "50", 10);
  const audit = createAuditService({ database: userAdminDatabaseGetter() });
  const items = await audit.list({
    actor_user_id: search.get("actorUserId") || undefined,
    target_user_id: search.get("targetUserId") || undefined,
    action: search.get("action") || undefined,
    entity_type: search.get("entityType") || undefined,
    entity_id: search.get("entityId") || undefined,
    request_id: search.get("requestId") || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
  });

  return {
    items: items.map(normalizeAuditLogRow),
  };
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
    elevatedFlowConfirmed: body.elevatedFlowConfirmed === true,
    rolePermissionIdsByRoleId: matrix,
  };
}

async function applyPermissionMatrixHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.permissions.update",
    action: "update",
    resource: {
      kind: "permission",
    },
  });

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

  if (protectedChangeCount > 0 && parsed.elevatedFlowConfirmed !== true) {
    throw PluginRouteError.badRequest("Protected permission changes require an elevated confirmation flow.");
  }

  const actorUserId = ctx.request.headers.get("x-actor-user-id")?.trim() ?? null;
  const rbac = userAdminRbacServiceFactory(db);
  const diffs = await rbac.applyPermissionMatrix({
    actor_user_id: actorUserId,
    rolePermissionIdsByRoleId: Object.fromEntries(snapshot.roles.map((role) => [role.id, nextByRoleId[role.id]])),
  });

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
    .leftJoin("user_roles", (join) =>
      join.onRef("user_roles.user_id", "=", "users.id").on("user_roles.expires_at", "is", null),
    )
    .leftJoin("roles", (join) => join.onRef("roles.id", "=", "user_roles.role_id").on("roles.deleted_at", "is", null))
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
      (eb) => eb.fn.max("roles.staff_level").as("active_role_staff_level"),
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
  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.users.read",
    action: "read",
  });

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

  const target = normalizeAuthorizationUserRow(row);

  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.users.read",
    action: "read",
    resource: {
      kind: "user",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  return {
    item: normalizeProfileRow(row),
  };
}

async function listRolesHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.roles.read",
    action: "read",
  });

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

async function listJobLevelsHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.jobs.read",
    action: "read",
    resource: {
      kind: "job",
    },
  });

  const db = userAdminDatabaseGetter();
  const search = new URL(ctx.request.url).searchParams;
  const limit = Number.parseInt(search.get("limit") ?? "50", 10);
  const includeDeleted = search.get("includeDeleted") === "true";

  let query = db
    .selectFrom("job_levels")
    .leftJoin("job_titles", (join) =>
      join.onRef("job_titles.job_level_id", "=", "job_levels.id").on("job_titles.deleted_at", "is", null),
    )
    .select([
      "job_levels.id as id",
      "job_levels.code as code",
      "job_levels.name as name",
      "job_levels.rank_order as rank_order",
      "job_levels.description as description",
      "job_levels.is_system as is_system",
      "job_levels.deleted_at as deleted_at",
      "job_levels.created_at as created_at",
      "job_levels.updated_at as updated_at",
      (eb) => eb.fn.count("job_titles.id").as("active_title_count"),
    ])
    .orderBy("job_levels.rank_order", "desc")
    .orderBy("job_levels.code", "asc");

  if (!includeDeleted) {
    query = query.where("job_levels.deleted_at", "is", null);
  }

  const rows = await query
    .groupBy([
      "job_levels.id",
      "job_levels.code",
      "job_levels.name",
      "job_levels.rank_order",
      "job_levels.description",
      "job_levels.is_system",
      "job_levels.deleted_at",
      "job_levels.created_at",
      "job_levels.updated_at",
    ])
    .limit(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50)
    .execute();

  return {
    items: rows.map(normalizeJobLevelRow),
  };
}

async function listJobTitlesHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.jobs.read",
    action: "read",
    resource: {
      kind: "job",
    },
  });

  const search = new URL(ctx.request.url).searchParams;
  const limit = Number.parseInt(search.get("limit") ?? "50", 10);
  const includeDeleted = search.get("includeDeleted") === "true";
  const levelId = search.get("jobLevelId") ?? undefined;
  const repo = createJobTitleRepository(userAdminDatabaseGetter());
  const levelRepo = createJobLevelRepository(userAdminDatabaseGetter());
  const titles = await repo.listJobTitles({
    job_level_id: levelId,
    includeDeleted,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50,
  });

  const levelsById = new Map();

  for (const title of titles) {
    if (!levelsById.has(title.job_level_id)) {
      levelsById.set(title.job_level_id, await levelRepo.getJobLevelById(title.job_level_id, { includeDeleted: true }));
    }
  }

  return {
    items: titles.map((title) => {
      const level = levelsById.get(title.job_level_id);

      return normalizeJobTitleRow({
        ...title,
        level_code: level?.code ?? null,
        level_name: level?.name ?? null,
        level_rank_order: level?.rank_order ?? 0,
      });
    }),
  };
}

async function listRegionsHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.regions.read",
    action: "read",
    resource: {
      kind: "region",
    },
  });

  const search = new URL(ctx.request.url).searchParams;
  const limit = Number.parseInt(search.get("limit") ?? "200", 10);
  const includeDeleted = search.get("includeDeleted") === "true";
  const repo = createRegionRepository(userAdminDatabaseGetter());
  const items = await repo.listRegions({
    includeDeleted,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200,
  });

  return {
    items: items.map(normalizeRegionRow),
  };
}

async function listAdministrativeRegionsHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.administrative_regions.assign",
    action: "read",
    resource: {
      kind: "administrative_region",
    },
  });

  const search = new URL(ctx.request.url).searchParams;
  const limit = Number.parseInt(search.get("limit") ?? "500", 10);
  const repo = createAdministrativeRegionRepository(userAdminDatabaseGetter());
  const items = await repo.listAdministrativeRegions({
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 500,
  });
  const latestUpdatedAt = items.reduce(
    (latest, item) => (!latest || String(item.updated_at ?? "") > String(latest) ? item.updated_at ?? latest : latest),
    null,
  );

  return {
    items: items.map(normalizeAdministrativeRegionRow),
    importStatus: {
      source: "src/db/data/administrative-regions.seed.json",
      command: "pnpm db:seed:administrative-regions",
      latestUpdatedAt,
      total: items.length,
    },
  };
}

async function listSecuritySettingsHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "security.2fa.read",
    action: "read",
    resource: {
      kind: "system",
    },
  });

  const db = userAdminDatabaseGetter();
  const roles = (await db
    .selectFrom("roles")
    .select(["id", "slug", "name", "staff_level", "is_assignable", "is_protected", "deleted_at"])
    .where("deleted_at", "is", null)
    .orderBy("staff_level", "desc")
    .orderBy("slug", "asc")
    .execute()).map(normalizeMatrixRoleRow);

  return {
    policy: getSecurityPolicy(),
    roles,
  };
}

async function updateSecuritySettingsHandler(ctx) {
  await requireAdminAuthorization(ctx, {
    permissionCode: "security.2fa.reset",
    action: "update",
    resource: {
      kind: "system",
    },
  });

  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const policy = updateSecurityPolicy({
    mandatoryTwoFactorRoleIds: Array.isArray(body?.mandatoryTwoFactorRoleIds) ? body.mandatoryTwoFactorRoleIds : [],
  });

  return {
    policy,
  };
}

async function createRegionHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.regions.read",
    action: "update",
    resource: {
      kind: "region",
    },
  });

  const regions = userAdminRegionServiceFactory(userAdminDatabaseGetter());
  await regions.createRegion({
    code: typeof body?.code === "string" ? body.code.trim() : "",
    name: typeof body?.name === "string" ? body.name.trim() : "",
    parent_id: typeof body?.parentId === "string" && body.parentId.trim() ? body.parentId.trim() : null,
    sort_order: body?.sortOrder,
  });

  return listRegionsHandler({
    ...ctx,
    request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/regions/list", {
      headers: ctx.request.headers,
    }),
  });
}

async function updateRegionHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.regions.read",
    action: "update",
    resource: {
      kind: "region",
    },
  });

  const regionId = typeof body?.regionId === "string" ? body.regionId.trim() : "";

  if (!regionId) {
    throw PluginRouteError.badRequest("Region id is required");
  }

  const regions = userAdminRegionServiceFactory(userAdminDatabaseGetter());
  await regions.updateRegion({
    region_id: regionId,
    code: typeof body?.code === "string" ? body.code.trim() : undefined,
    name: typeof body?.name === "string" ? body.name.trim() : undefined,
    sort_order: body?.sortOrder,
    is_active: body?.isActive,
  });

  return listRegionsHandler({
    ...ctx,
    request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/regions/list", {
      headers: ctx.request.headers,
    }),
  });
}

async function reparentRegionHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.regions.read",
    action: "update",
    resource: {
      kind: "region",
    },
  });

  const regionId = typeof body?.regionId === "string" ? body.regionId.trim() : "";

  if (!regionId) {
    throw PluginRouteError.badRequest("Region id is required");
  }

  const regions = userAdminRegionServiceFactory(userAdminDatabaseGetter());
  await regions.reparentRegion({
    region_id: regionId,
    parent_id: typeof body?.parentId === "string" && body.parentId.trim() ? body.parentId.trim() : null,
  });

  return listRegionsHandler({
    ...ctx,
    request: new Request("http://example.test/_emdash/api/plugins/awcms-users-admin/regions/list", {
      headers: ctx.request.headers,
    }),
  });
}

async function listSupervisorCandidates(db, excludedUserId) {
  const rows = await db
    .selectFrom("users")
    .select(["id", "email", "display_name", "status", "deleted_at"])
    .where("deleted_at", "is", null)
    .where("status", "=", "active")
    .orderBy("display_name", "asc")
    .orderBy("email", "asc")
    .execute();

  return rows
    .filter((row) => row.id !== excludedUserId)
    .map((row) => ({
      id: row.id,
      displayName: row.display_name || row.email,
      email: row.email,
    }));
}

async function listUserJobsHandler(ctx) {
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("id");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.jobs.read",
    action: "read",
    resource: {
      kind: "job",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const jobRepo = createUserJobRepository(db);
  const levelRepo = createJobLevelRepository(db);
  const titleRepo = createJobTitleRepository(db);
  const assignments = await jobRepo.listUserJobsByUserId(userId, { activeOnly: false });

  const levels = await levelRepo.listJobLevels({ includeDeleted: false, limit: 200 });
  const titles = await titleRepo.listJobTitles({ includeDeleted: false, limit: 200 });
  const levelsById = new Map(levels.map((level) => [level.id, level]));
  const titlesById = new Map(titles.map((title) => [title.id, title]));
  const supervisorsById = new Map();

  for (const assignment of assignments) {
    if (assignment.supervisor_user_id && !supervisorsById.has(assignment.supervisor_user_id)) {
      supervisorsById.set(assignment.supervisor_user_id, await getUserSummaryRow(db, assignment.supervisor_user_id));
    }
  }

  return {
    assignments: assignments.map((assignment) => {
      const level = levelsById.get(assignment.job_level_id);
      const title = assignment.job_title_id ? titlesById.get(assignment.job_title_id) : null;
      const supervisor = assignment.supervisor_user_id ? supervisorsById.get(assignment.supervisor_user_id) : null;

      return normalizeUserJobAssignmentRow({
        ...assignment,
        job_level_code: level?.code ?? null,
        job_level_name: level?.name ?? null,
        job_level_rank_order: level?.rank_order ?? 0,
        job_title_code: title?.code ?? null,
        job_title_name: title?.name ?? null,
        supervisor_display_name: supervisor?.display_name || supervisor?.email || null,
      });
    }),
    jobLevels: levels.map(normalizeJobLevelRow),
    jobTitles: titles.map((title) =>
      normalizeJobTitleRow({
        ...title,
        level_code: levelsById.get(title.job_level_id)?.code ?? null,
        level_name: levelsById.get(title.job_level_id)?.name ?? null,
        level_rank_order: levelsById.get(title.job_level_id)?.rank_order ?? 0,
      }),
    ),
    supervisorCandidates: await listSupervisorCandidates(db, userId),
  };
}

async function listUserRolesHandler(ctx) {
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("id");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.roles.read",
    action: "read",
    resource: {
      kind: "role",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const roles = userAdminRoleAssignmentServiceFactory(db);
  const availableRoles = (await db
    .selectFrom("roles")
    .select(["id", "slug", "name", "description", "staff_level", "is_system", "is_assignable", "is_protected", "deleted_at", "created_at", "updated_at"])
    .where("deleted_at", "is", null)
    .orderBy("staff_level", "desc")
    .orderBy("slug", "asc")
    .execute()).map(normalizeRoleRow);

  return {
    assignments: (await roles.listActiveRoles(userId)).map(normalizeUserRoleAssignmentRow),
    roles: availableRoles,
  };
}

async function assignUserRoleHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const roleId = typeof body?.roleId === "string" ? body.roleId.trim() : "";

  if (!userId || !roleId) {
    throw PluginRouteError.badRequest("User id and role id are required");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.roles.assign",
    action: "assign",
    resource: {
      kind: "role",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const actorUserId = ctx.request.headers.get("x-actor-user-id")?.trim() ?? null;
  const roles = userAdminRoleAssignmentServiceFactory(db);
  await roles.assignRole({
    user_id: userId,
    role_id: roleId,
    assigned_by_user_id: actorUserId,
    is_primary: body?.isPrimary !== false,
    confirm_protected_role_change: body?.confirmProtectedRoleChange === true,
  });

  return listUserRolesHandler({
    ...ctx,
    request: new Request(`http://example.test/_emdash/api/plugins/awcms-users-admin/users/roles?id=${encodeURIComponent(userId)}`, {
      headers: ctx.request.headers,
    }),
  });
}

async function listUserRegionsHandler(ctx) {
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("id");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.regions.read",
    action: "read",
    resource: {
      kind: "region",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const assignmentRepo = createUserRegionAssignmentRepository(db);
  const regionRepo = createRegionRepository(db);
  const assignments = await assignmentRepo.listUserRegionAssignmentsByUserId(userId, { activeOnly: false });
  const regions = await regionRepo.listRegions({ includeDeleted: false, is_active: true, limit: 500 });
  const regionsById = new Map(regions.map((region) => [region.id, region]));

  return {
    assignments: assignments.map((assignment) => {
      const region = regionsById.get(assignment.region_id);

      return normalizeUserRegionAssignmentRow({
        ...assignment,
        region_code: region?.code ?? null,
        region_name: region?.name ?? null,
        region_level: region?.level ?? 0,
        region_path: region?.path ?? null,
      });
    }),
    regions: regions.map(normalizeRegionRow),
  };
}

async function assignUserRegionHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const regionId = typeof body?.regionId === "string" ? body.regionId.trim() : "";
  const assignmentType = typeof body?.assignmentType === "string" ? body.assignmentType.trim() : "";
  const startsAt = typeof body?.startsAt === "string" ? body.startsAt.trim() : "";

  if (!userId || !regionId) {
    throw PluginRouteError.badRequest("User id and region id are required");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.regions.read",
    action: "assign",
    resource: {
      kind: "region",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const actorUserId = ctx.request.headers.get("x-actor-user-id")?.trim() ?? null;
  const regionAssignments = userAdminRegionAssignmentServiceFactory(db);
  await regionAssignments.assignRegion({
    user_id: userId,
    region_id: regionId,
    assignment_type: assignmentType || "member",
    starts_at: startsAt || undefined,
    is_primary: body?.isPrimary !== false,
    assigned_by_user_id: actorUserId,
  });

  return listUserRegionsHandler({
    ...ctx,
    request: new Request(`http://example.test/_emdash/api/plugins/awcms-users-admin/users/regions?id=${encodeURIComponent(userId)}`, {
      headers: ctx.request.headers,
    }),
  });
}

async function listUserAdministrativeRegionsHandler(ctx) {
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("id");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.administrative_regions.assign",
    action: "read",
    resource: {
      kind: "administrative_region",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const assignmentRepo = createUserAdministrativeRegionAssignmentRepository(db);
  const regionRepo = createAdministrativeRegionRepository(db);
  const assignments = await assignmentRepo.listUserAdministrativeRegionAssignmentsByUserId(userId, { activeOnly: false });
  const regions = await regionRepo.listAdministrativeRegions({ is_active: true, limit: 1000 });
  const regionsById = new Map(regions.map((region) => [region.id, region]));

  return {
    assignments: assignments.map((assignment) => {
      const region = regionsById.get(assignment.administrative_region_id);

      return normalizeUserAdministrativeRegionAssignmentRow({
        ...assignment,
        administrative_region_code: region?.code ?? null,
        administrative_region_name: region?.name ?? null,
        administrative_region_type: region?.type ?? null,
        administrative_region_path: region?.path ?? null,
      });
    }),
    regions: regions.map(normalizeAdministrativeRegionRow),
  };
}

async function listUserSessionsHandler(ctx) {
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("id");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "security.sessions.read",
    action: "read",
    resource: {
      kind: "session",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const sessions = createSessionRepository(db);
  const loginEvents = createLoginSecurityEventRepository(db);

  return {
    sessions: (await sessions.listSessionsByUserId(userId, { includeRevoked: true, limit: 50 })).map(normalizeSessionRow),
    loginEvents: (await loginEvents.listEvents({ userId, limit: 50 })).map(normalizeLoginSecurityEventRow),
  };
}

async function revokeUserSessionHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";

  if (!userId || !sessionId) {
    throw PluginRouteError.badRequest("User id and session id are required");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "security.sessions.revoke",
    action: "revoke",
    resource: {
      kind: "session",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const service = userAdminSessionServiceFactory(db);
  await service.revokeSession(sessionId);

  return listUserSessionsHandler({
    ...ctx,
    request: new Request(`http://example.test/_emdash/api/plugins/awcms-users-admin/users/sessions?id=${encodeURIComponent(userId)}`, {
      headers: ctx.request.headers,
    }),
  });
}

async function assignUserAdministrativeRegionHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const administrativeRegionId = typeof body?.administrativeRegionId === "string" ? body.administrativeRegionId.trim() : "";
  const assignmentType = typeof body?.assignmentType === "string" ? body.assignmentType.trim() : "";
  const startsAt = typeof body?.startsAt === "string" ? body.startsAt.trim() : "";

  if (!userId || !administrativeRegionId) {
    throw PluginRouteError.badRequest("User id and administrative region id are required");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.administrative_regions.assign",
    action: "assign",
    resource: {
      kind: "administrative_region",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const actorUserId = ctx.request.headers.get("x-actor-user-id")?.trim() ?? null;
  const administrativeRegionAssignments = userAdminAdministrativeRegionAssignmentServiceFactory(db);
  await administrativeRegionAssignments.assignAdministrativeRegion({
    user_id: userId,
    administrative_region_id: administrativeRegionId,
    assignment_type: assignmentType || "member",
    starts_at: startsAt || undefined,
    is_primary: body?.isPrimary !== false,
    assigned_by_user_id: actorUserId,
  });

  return listUserAdministrativeRegionsHandler({
    ...ctx,
    request: new Request(`http://example.test/_emdash/api/plugins/awcms-users-admin/users/administrative-regions?id=${encodeURIComponent(userId)}`, {
      headers: ctx.request.headers,
    }),
  });
}

async function listUserTwoFactorStatusHandler(ctx) {
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("id");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "security.2fa.read",
    action: "read",
    resource: {
      kind: "user",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const service = userAdminAdminTwoFactorServiceFactory(db);
  return service.getUserTwoFactorStatus(userId);
}

async function resetUserTwoFactorHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "security.2fa.reset",
    action: "reset",
    resource: {
      kind: "user",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const sessionStrength = ctx.request.headers.get("x-session-strength")?.trim() ?? "none";
  const stepUpAuthenticated = ctx.request.headers.get("x-step-up-authenticated")?.trim() === "true";

  if (sessionStrength !== "step_up" || !stepUpAuthenticated) {
    throw PluginRouteError.forbidden("STEP_UP_REQUIRED");
  }

  const actorUserId = ctx.request.headers.get("x-actor-user-id")?.trim() ?? null;
  const service = userAdminAdminTwoFactorServiceFactory(db);
  return service.resetUserTwoFactor({
    user_id: userId,
    actor_user_id: actorUserId,
    reason: typeof body?.reason === "string" ? body.reason.trim() : null,
  });
}

async function assignUserJobHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const jobLevelId = typeof body?.jobLevelId === "string" ? body.jobLevelId.trim() : "";
  const jobTitleId = typeof body?.jobTitleId === "string" ? body.jobTitleId.trim() : "";
  const supervisorUserId = typeof body?.supervisorUserId === "string" ? body.supervisorUserId.trim() : "";
  const employmentStatus = typeof body?.employmentStatus === "string" ? body.employmentStatus.trim() : "";
  const startsAt = typeof body?.startsAt === "string" ? body.startsAt.trim() : "";
  const notes = typeof body?.notes === "string" ? body.notes.trim() : "";

  if (!userId || !jobLevelId) {
    throw PluginRouteError.badRequest("User id and job level id are required");
  }

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);

  await requireAdminAuthorization(ctx, {
    permissionCode: "governance.jobs.assign",
    action: "assign",
    resource: {
      kind: "job",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

  const actorUserId = ctx.request.headers.get("x-actor-user-id")?.trim() ?? null;
  const jobs = userAdminJobsServiceFactory(db);
  await jobs.assignJob({
    user_id: userId,
    job_level_id: jobLevelId,
    job_title_id: jobTitleId || null,
    supervisor_user_id: supervisorUserId || null,
    employment_status: employmentStatus || "active",
    starts_at: startsAt || undefined,
    is_primary: body?.isPrimary !== false,
    assigned_by_user_id: actorUserId,
    notes: notes || null,
  });

  return listUserJobsHandler({
    ...ctx,
    request: new Request(`http://example.test/_emdash/api/plugins/awcms-users-admin/users/jobs?id=${encodeURIComponent(userId)}`, {
      headers: ctx.request.headers,
    }),
  });
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

  await requireAdminAuthorization(ctx, {
    permissionCode: "admin.users.invite",
    action: "create",
  });

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

  const db = userAdminDatabaseGetter();
  const targetRow = await getUserSummaryRow(db, userId);

  if (!targetRow) {
    throw PluginRouteError.notFound(`User not found: ${userId}`);
  }

  const target = normalizeAuthorizationUserRow(targetRow);
  const permissionCode = action === "revoke-sessions" ? "security.sessions.revoke" : "admin.users.disable";

  await requireAdminAuthorization(ctx, {
    permissionCode,
    action: action === "revoke-sessions" ? "revoke" : "update",
    resource: {
      kind: "user",
      target_user_id: target.id,
      target_staff_level: target.activeRoleStaffLevel,
      is_protected: target.isProtected,
    },
  });

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

  return {
    item: normalizeProfileRow(await getUserSummaryRow(userAdminDatabaseGetter(), userId)),
  };
}

export function createPlugin() {
  return definePlugin({
    id: "awcms-users-admin",
    version: "0.1.0",
    capabilities: ["read:users"],
    permissions: USER_ADMIN_PLUGIN_PERMISSIONS,
    routes: {
      "users/list": {
        handler: listUsersHandler,
      },
      "roles/list": {
        handler: listRolesHandler,
      },
      "users/jobs": {
        handler: listUserJobsHandler,
      },
      "users/roles": {
        handler: listUserRolesHandler,
      },
      "users/roles/assign": {
        handler: assignUserRoleHandler,
      },
      "users/jobs/assign": {
        handler: assignUserJobHandler,
      },
      "users/regions": {
        handler: listUserRegionsHandler,
      },
      "users/regions/assign": {
        handler: assignUserRegionHandler,
      },
      "users/administrative-regions": {
        handler: listUserAdministrativeRegionsHandler,
      },
      "users/sessions": {
        handler: listUserSessionsHandler,
      },
      "users/sessions/revoke": {
        handler: revokeUserSessionHandler,
      },
      "users/administrative-regions/assign": {
        handler: assignUserAdministrativeRegionHandler,
      },
      "users/2fa/status": {
        handler: listUserTwoFactorStatusHandler,
      },
      "users/2fa/reset": {
        handler: resetUserTwoFactorHandler,
      },
      "security/settings": {
        handler: listSecuritySettingsHandler,
      },
      "security/settings/update": {
        handler: updateSecuritySettingsHandler,
      },
      "jobs/levels/list": {
        handler: listJobLevelsHandler,
      },
      "jobs/titles/list": {
        handler: listJobTitlesHandler,
      },
      "regions/list": {
        handler: listRegionsHandler,
      },
      "regions/create": {
        handler: createRegionHandler,
      },
      "regions/update": {
        handler: updateRegionHandler,
      },
      "regions/reparent": {
        handler: reparentRegionHandler,
      },
      "administrative-regions/list": {
        handler: listAdministrativeRegionsHandler,
      },
      "permissions/matrix": {
        handler: listPermissionMatrixHandler,
      },
      "audit/logs": {
        handler: listAuditLogsHandler,
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
          { path: "/regions", label: "Logical Regions", icon: "map" },
          { path: "/administrative-regions", label: "Administrative Regions", icon: "globe" },
          { path: "/audit", label: "Audit Logs", icon: "clipboard-list" },
          { path: "/security", label: "Security Settings", icon: "lock" },
          { path: "/jobs/levels", label: "Job Levels", icon: "layers" },
          { path: "/jobs/titles", label: "Job Titles", icon: "briefcase" },
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
    permissions: USER_ADMIN_PLUGIN_PERMISSIONS,
    adminPages: [
      { path: "/", label: "Users", icon: "users" },
      { path: "/roles", label: "Roles", icon: "shield" },
      { path: "/regions", label: "Logical Regions", icon: "map" },
      { path: "/administrative-regions", label: "Administrative Regions", icon: "globe" },
      { path: "/audit", label: "Audit Logs", icon: "clipboard-list" },
      { path: "/security", label: "Security Settings", icon: "lock" },
      { path: "/jobs/levels", label: "Job Levels", icon: "layers" },
      { path: "/jobs/titles", label: "Job Titles", icon: "briefcase" },
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

export function setUserAdminJobsServiceFactory(factory) {
  userAdminJobsServiceFactory = factory;
}

export function resetUserAdminJobsServiceFactory() {
  userAdminJobsServiceFactory = (database) => createJobsService({ database });
}

export function setUserAdminRegionServiceFactory(factory) {
  userAdminRegionServiceFactory = factory;
}

export function resetUserAdminRegionServiceFactory() {
  userAdminRegionServiceFactory = (database) => createRegionService({ database });
}

export function setUserAdminRegionAssignmentServiceFactory(factory) {
  userAdminRegionAssignmentServiceFactory = factory;
}

export function resetUserAdminRegionAssignmentServiceFactory() {
  userAdminRegionAssignmentServiceFactory = (database) => createRegionAssignmentService({ database });
}

export function setUserAdminAdministrativeRegionAssignmentServiceFactory(factory) {
  userAdminAdministrativeRegionAssignmentServiceFactory = factory;
}

export function resetUserAdminAdministrativeRegionAssignmentServiceFactory() {
  userAdminAdministrativeRegionAssignmentServiceFactory = (database) => createAdministrativeRegionAssignmentService({ database });
}

export function setUserAdminAdminTwoFactorServiceFactory(factory) {
  userAdminAdminTwoFactorServiceFactory = factory;
}

export function resetUserAdminAdminTwoFactorServiceFactory() {
  userAdminAdminTwoFactorServiceFactory = (database) => createAdminTwoFactorService({ database });
}

export function setUserAdminAuthorizationServiceFactory(factory) {
  userAdminAuthorizationServiceFactory = factory;
}

export function resetUserAdminAuthorizationServiceFactory() {
  userAdminAuthorizationServiceFactory = (database) => createAuthorizationService({ database });
}

export function setUserAdminRbacServiceFactory(factory) {
  userAdminRbacServiceFactory = factory;
}

export function resetUserAdminRbacServiceFactory() {
  userAdminRbacServiceFactory = (database) => createRbacService({ database });
}

export function setUserAdminRoleAssignmentServiceFactory(factory) {
  userAdminRoleAssignmentServiceFactory = factory;
}

export function resetUserAdminRoleAssignmentServiceFactory() {
  userAdminRoleAssignmentServiceFactory = (database) => createRoleAssignmentService({ database });
}

export function setUserAdminSessionServiceFactory(factory) {
  userAdminSessionServiceFactory = factory;
}

export function resetUserAdminSessionServiceFactory() {
  userAdminSessionServiceFactory = (database) => createSessionService({ database });
}

export default createPlugin;
