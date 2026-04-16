import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createAdministrativeRegionRepository } from "../../db/repositories/administrative-regions.mjs";
import { createUserAdministrativeRegionAssignmentRepository } from "../../db/repositories/user-administrative-region-assignments.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";

export class AdministrativeRegionAssignmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdministrativeRegionAssignmentError";
    this.code = code;
  }
}

function createAdministrativeRegionAssignmentServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    administrativeRegions: createAdministrativeRegionRepository(executor),
    userAdministrativeRegionAssignments: createUserAdministrativeRegionAssignmentRepository(executor),
    executor,
  };
}

async function updateUserAdministrativeRegionAssignmentEndsAt(executor, id, endsAt) {
  await executor
    .updateTable("user_administrative_region_assignments")
    .set({ ends_at: endsAt })
    .where("id", "=", id)
    .where("ends_at", "is", null)
    .execute();
}

async function resolveAdministrativeRegionAssignmentContext(deps, input) {
  const user = await deps.users.getUserById(input.user_id, { includeDeleted: true });

  if (!user || user.deleted_at || user.status === "deleted") {
    throw new AdministrativeRegionAssignmentError("USER_NOT_FOUND", "User is not available for administrative region assignment.");
  }

  const administrativeRegion = await deps.administrativeRegions.getAdministrativeRegionById(input.administrative_region_id);

  if (!administrativeRegion || administrativeRegion.is_active === false) {
    throw new AdministrativeRegionAssignmentError(
      "ADMINISTRATIVE_REGION_NOT_FOUND",
      "Administrative region is not available for assignment.",
    );
  }

  return {
    administrativeRegion,
    user,
  };
}

async function getActiveAdministrativeRegionAssignmentBySignature(deps, userId, administrativeRegionId, assignmentType) {
  const activeAssignments = await deps.userAdministrativeRegionAssignments.listUserAdministrativeRegionAssignmentsByUserId(userId, {
    activeOnly: true,
  });
  return (
    activeAssignments.find(
      (assignment) =>
        assignment.administrative_region_id === administrativeRegionId && assignment.assignment_type === assignmentType,
    ) ?? null
  );
}

async function expireExistingPrimaryIfNeeded(deps, userId, desiredPrimary, effectiveAt, exceptAssignmentId = null) {
  if (!desiredPrimary) {
    return;
  }

  const activeAssignments = await deps.userAdministrativeRegionAssignments.listUserAdministrativeRegionAssignmentsByUserId(userId, {
    activeOnly: true,
  });

  for (const assignment of activeAssignments) {
    if (!assignment.is_primary) {
      continue;
    }

    if (exceptAssignmentId && assignment.id === exceptAssignmentId) {
      continue;
    }

    await updateUserAdministrativeRegionAssignmentEndsAt(deps.executor, assignment.id, effectiveAt);
  }
}

export function createAdministrativeRegionAssignmentService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async assignAdministrativeRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createAdministrativeRegionAssignmentServiceDependencies(trx);
        const context = await resolveAdministrativeRegionAssignmentContext(deps, input);
        const activeAssignments = await deps.userAdministrativeRegionAssignments.listUserAdministrativeRegionAssignmentsByUserId(
          context.user.id,
          { activeOnly: true },
        );
        const assignmentType = input.assignment_type ?? "member";
        const currentAssignment = await getActiveAdministrativeRegionAssignmentBySignature(
          deps,
          context.user.id,
          context.administrativeRegion.id,
          assignmentType,
        );
        const desiredPrimary = input.is_primary ?? activeAssignments.length === 0;

        if (currentAssignment && currentAssignment.is_primary === desiredPrimary) {
          return currentAssignment;
        }

        const effectiveAt = input.starts_at ?? new Date().toISOString();

        if (currentAssignment) {
          await updateUserAdministrativeRegionAssignmentEndsAt(deps.executor, currentAssignment.id, effectiveAt);
        }

        await expireExistingPrimaryIfNeeded(deps, context.user.id, desiredPrimary, effectiveAt, currentAssignment?.id ?? null);

        return deps.userAdministrativeRegionAssignments.createUserAdministrativeRegionAssignment({
          id: input.id ?? crypto.randomUUID(),
          user_id: context.user.id,
          administrative_region_id: context.administrativeRegion.id,
          assignment_type: assignmentType,
          is_primary: desiredPrimary,
          starts_at: effectiveAt,
          ends_at: input.ends_at ?? null,
          assigned_by_user_id: input.assigned_by_user_id ?? null,
        });
      });
    },

    async changeAdministrativeRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createAdministrativeRegionAssignmentServiceDependencies(trx);
        const existing = await deps.userAdministrativeRegionAssignments.getUserAdministrativeRegionAssignmentById(input.assignment_id);

        if (!existing) {
          throw new AdministrativeRegionAssignmentError(
            "ADMINISTRATIVE_REGION_ASSIGNMENT_NOT_FOUND",
            "Administrative region assignment was not found.",
          );
        }

        if (existing.ends_at) {
          throw new AdministrativeRegionAssignmentError(
            "ADMINISTRATIVE_REGION_ASSIGNMENT_INACTIVE",
            "Administrative region assignment is no longer active.",
          );
        }

        const nextAdministrativeRegionId = input.administrative_region_id ?? existing.administrative_region_id;
        const nextAssignmentType = input.assignment_type ?? existing.assignment_type;
        const context = await resolveAdministrativeRegionAssignmentContext(deps, {
          user_id: existing.user_id,
          administrative_region_id: nextAdministrativeRegionId,
        });

        const duplicate = await getActiveAdministrativeRegionAssignmentBySignature(
          deps,
          context.user.id,
          context.administrativeRegion.id,
          nextAssignmentType,
        );

        if (duplicate && duplicate.id !== existing.id) {
          throw new AdministrativeRegionAssignmentError(
            "ADMINISTRATIVE_REGION_ASSIGNMENT_ALREADY_ACTIVE",
            "An active administrative region assignment already exists for this user, region, and assignment type.",
          );
        }

        const effectiveAt = input.starts_at ?? new Date().toISOString();
        await updateUserAdministrativeRegionAssignmentEndsAt(deps.executor, existing.id, effectiveAt);

        const desiredPrimary = input.is_primary ?? existing.is_primary;
        await expireExistingPrimaryIfNeeded(deps, context.user.id, desiredPrimary, effectiveAt, existing.id);

        return deps.userAdministrativeRegionAssignments.createUserAdministrativeRegionAssignment({
          id: input.id ?? crypto.randomUUID(),
          user_id: context.user.id,
          administrative_region_id: context.administrativeRegion.id,
          assignment_type: nextAssignmentType,
          is_primary: desiredPrimary,
          starts_at: effectiveAt,
          ends_at: input.ends_at ?? null,
          assigned_by_user_id: input.assigned_by_user_id ?? existing.assigned_by_user_id ?? null,
        });
      });
    },

    async endAdministrativeRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createAdministrativeRegionAssignmentServiceDependencies(trx);
        const existing = await deps.userAdministrativeRegionAssignments.getUserAdministrativeRegionAssignmentById(input.assignment_id);

        if (!existing) {
          throw new AdministrativeRegionAssignmentError(
            "ADMINISTRATIVE_REGION_ASSIGNMENT_NOT_FOUND",
            "Administrative region assignment was not found.",
          );
        }

        if (existing.ends_at) {
          return existing;
        }

        const endsAt = input.ends_at ?? new Date().toISOString();
        await updateUserAdministrativeRegionAssignmentEndsAt(deps.executor, existing.id, endsAt);
        return deps.userAdministrativeRegionAssignments.getUserAdministrativeRegionAssignmentById(existing.id);
      });
    },

    async listActiveAdministrativeRegions(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createAdministrativeRegionAssignmentServiceDependencies(trx);
        const user = await deps.users.getUserById(userId, { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          return [];
        }

        return deps.userAdministrativeRegionAssignments.listUserAdministrativeRegionAssignmentsByUserId(userId, {
          activeOnly: true,
        });
      });
    },
  };
}
