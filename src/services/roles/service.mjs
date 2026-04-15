import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createRoleRepository } from "../../db/repositories/roles.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";

const USER_ROLE_COLUMNS = [
  "id",
  "user_id",
  "role_id",
  "assigned_by_user_id",
  "assigned_at",
  "expires_at",
  "is_primary",
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

function baseUserRoleQuery(executor) {
  return executor.selectFrom("user_roles").select(USER_ROLE_COLUMNS);
}

async function listUserRoleAssignments(executor, userId, options = {}) {
  let query = baseUserRoleQuery(executor)
    .where("user_id", "=", userId)
    .orderBy("is_primary", "desc")
    .orderBy("assigned_at", "desc")
    .orderBy("id", "asc");

  if (options.includeExpired !== true) {
    query = query.where("expires_at", "is", null);
  }

  const rows = await query.execute();
  return rows.map(normalizeUserRole);
}

async function getActiveUserRoleAssignment(executor, userId, roleId) {
  const row = await baseUserRoleQuery(executor)
    .where("user_id", "=", userId)
    .where("role_id", "=", roleId)
    .where("expires_at", "is", null)
    .executeTakeFirst();

  return normalizeUserRole(row);
}

async function createUserRoleAssignment(executor, input) {
  await executor
    .insertInto("user_roles")
    .values({
      id: input.id,
      user_id: input.user_id,
      role_id: input.role_id,
      assigned_by_user_id: input.assigned_by_user_id ?? null,
      assigned_at: input.assigned_at ?? undefined,
      expires_at: input.expires_at ?? null,
      is_primary: input.is_primary ?? false,
    })
    .execute();

  return getUserRoleAssignmentById(executor, input.id);
}

async function getUserRoleAssignmentById(executor, id) {
  const row = await baseUserRoleQuery(executor).where("id", "=", id).executeTakeFirst();
  return normalizeUserRole(row);
}

async function expireUserRoleAssignment(executor, id, expiresAt) {
  await executor
    .updateTable("user_roles")
    .set({
      expires_at: expiresAt,
    })
    .where("id", "=", id)
    .where("expires_at", "is", null)
    .execute();

  return getUserRoleAssignmentById(executor, id);
}

async function hydrateAssignment(deps, assignment) {
  if (!assignment) {
    return undefined;
  }

  return {
    ...assignment,
    role: await deps.roles.getRoleById(assignment.role_id),
  };
}

async function hydrateAssignments(deps, assignments) {
  const entries = [];

  for (const assignment of assignments) {
    entries.push(await hydrateAssignment(deps, assignment));
  }

  return entries;
}

async function runHook(hook, context, deniedCode, deniedMessage) {
  if (typeof hook !== "function") {
    return;
  }

  const result = await hook(context);

  if (result === false) {
    throw new RoleAssignmentError(deniedCode, deniedMessage);
  }
}

function createRoleAssignmentServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    roles: createRoleRepository(executor),
    userRoles: {
      createAssignment(input) {
        return createUserRoleAssignment(executor, input);
      },
      expireAssignment(id, expiresAt) {
        return expireUserRoleAssignment(executor, id, expiresAt);
      },
      getActiveAssignment(userId, roleId) {
        return getActiveUserRoleAssignment(executor, userId, roleId);
      },
      listAssignments(userId, options) {
        return listUserRoleAssignments(executor, userId, options);
      },
    },
  };
}

async function resolveAssignmentContext(deps, input) {
  const user = await deps.users.getUserById(input.user_id, { includeDeleted: true });

  if (!user || user.deleted_at || user.status === "deleted") {
    throw new RoleAssignmentError("USER_NOT_FOUND", "User is not available for role assignment.");
  }

  const role = await deps.roles.getRoleById(input.role_id, { includeDeleted: false });

  if (!role) {
    throw new RoleAssignmentError("ROLE_NOT_FOUND", "Role is not available for assignment.");
  }

  const activeAssignments = await deps.userRoles.listAssignments(user.id);

  return {
    activeAssignments,
    role,
    user,
  };
}

function requiresProtectedRoleConfirmation(context, desiredPrimary) {
  if (context.role.is_protected) {
    return true;
  }

  if (!desiredPrimary) {
    return false;
  }

  return context.activeAssignments.some((assignment) => assignment.is_primary && assignment.role?.is_protected);
}

function assertProtectedRoleConfirmation(context, desiredPrimary, confirmed) {
  if (!requiresProtectedRoleConfirmation(context, desiredPrimary)) {
    return;
  }

  if (confirmed === true) {
    return;
  }

  throw new RoleAssignmentError(
    "PROTECTED_ROLE_CONFIRMATION_REQUIRED",
    "Protected role changes require an explicit elevated confirmation flow.",
  );
}

export class RoleAssignmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoleAssignmentError";
    this.code = code;
  }
}

export function createRoleAssignmentService(options = {}) {
  const database = options.database ?? getDatabase();
  const hooks = options.hooks ?? {};

  return {
    async assignRole(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRoleAssignmentServiceDependencies(trx);
        const context = await resolveAssignmentContext(deps, input);
        const currentAssignment = await deps.userRoles.getActiveAssignment(input.user_id, input.role_id);
        const desiredPrimary = input.is_primary ?? context.activeAssignments.length === 0;

        await runHook(
          hooks.beforeAssignRole,
          {
            activeAssignments: context.activeAssignments,
            actor_user_id: input.assigned_by_user_id ?? null,
            next_is_primary: desiredPrimary,
            role: context.role,
            user: context.user,
          },
          "ASSIGNMENT_DENIED",
          "Role assignment was denied by a protection hook.",
        );

        assertProtectedRoleConfirmation(context, desiredPrimary, input.confirm_protected_role_change);

        if (currentAssignment && currentAssignment.is_primary === desiredPrimary) {
          return hydrateAssignment(deps, currentAssignment);
        }

        const expiresAt = input.replaced_at ?? new Date().toISOString();

        if (currentAssignment) {
          await deps.userRoles.expireAssignment(currentAssignment.id, expiresAt);
        }

        if (desiredPrimary) {
          for (const assignment of context.activeAssignments) {
            if (assignment.is_primary && assignment.role_id !== input.role_id) {
              await deps.userRoles.expireAssignment(assignment.id, expiresAt);
            }
          }
        }

        const assignment = await deps.userRoles.createAssignment({
          id: input.id ?? crypto.randomUUID(),
          user_id: context.user.id,
          role_id: context.role.id,
          assigned_by_user_id: input.assigned_by_user_id ?? null,
          assigned_at: input.assigned_at,
          expires_at: null,
          is_primary: desiredPrimary,
        });

        return hydrateAssignment(deps, assignment);
      });
    },

    async revokeRole(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRoleAssignmentServiceDependencies(trx);
        const context = await resolveAssignmentContext(deps, input);
        const assignment = await deps.userRoles.getActiveAssignment(input.user_id, input.role_id);

        if (!assignment) {
          return undefined;
        }

        await runHook(
          hooks.beforeRevokeRole,
          {
            activeAssignments: context.activeAssignments,
            actor_user_id: input.revoked_by_user_id ?? null,
            assignment,
            role: context.role,
            user: context.user,
          },
          "REVOCATION_DENIED",
          "Role revocation was denied by a protection hook.",
        );

        if (context.role.is_protected && input.confirm_protected_role_change !== true) {
          throw new RoleAssignmentError(
            "PROTECTED_ROLE_CONFIRMATION_REQUIRED",
            "Protected role changes require an explicit elevated confirmation flow.",
          );
        }

        const revoked = await deps.userRoles.expireAssignment(
          assignment.id,
          input.expires_at ?? new Date().toISOString(),
        );

        return hydrateAssignment(deps, revoked);
      });
    },

    async listActiveRoles(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createRoleAssignmentServiceDependencies(trx);
        const user = await deps.users.getUserById(userId, { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          return [];
        }

        const assignments = await deps.userRoles.listAssignments(userId, { includeExpired: false });
        return hydrateAssignments(deps, assignments);
      });
    },
  };
}

export { USER_ROLE_COLUMNS, normalizeUserRole };
