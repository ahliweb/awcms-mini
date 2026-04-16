import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createRegionRepository } from "../../db/repositories/regions.mjs";
import { createUserRegionAssignmentRepository } from "../../db/repositories/user-region-assignments.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import { createAuditService } from "../audit/service.mjs";

export class RegionAssignmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegionAssignmentError";
    this.code = code;
  }
}

function createRegionAssignmentServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    regions: createRegionRepository(executor),
    userRegionAssignments: createUserRegionAssignmentRepository(executor),
    audit: createAuditService({ database: executor }),
    executor,
  };
}

async function appendRegionAssignmentAudit(deps, input) {
  await deps.audit.append({
    actor_user_id: input.actor_user_id ?? null,
    action: input.action,
    entity_type: "region_assignment",
    entity_id: input.entity_id ?? null,
    target_user_id: input.target_user_id ?? null,
    summary: input.summary,
    before_payload: input.before_payload ?? null,
    after_payload: input.after_payload ?? null,
    metadata: input.metadata ?? {},
  });
}

async function updateUserRegionAssignmentEndsAt(executor, id, endsAt) {
  await executor
    .updateTable("user_region_assignments")
    .set({ ends_at: endsAt })
    .where("id", "=", id)
    .where("ends_at", "is", null)
    .execute();
}

async function resolveRegionAssignmentContext(deps, input) {
  const user = await deps.users.getUserById(input.user_id, { includeDeleted: true });

  if (!user || user.deleted_at || user.status === "deleted") {
    throw new RegionAssignmentError("USER_NOT_FOUND", "User is not available for logical region assignment.");
  }

  const region = await deps.regions.getRegionById(input.region_id, { includeDeleted: false });

  if (!region || region.is_active === false) {
    throw new RegionAssignmentError("REGION_NOT_FOUND", "Logical region is not available for assignment.");
  }

  return {
    region,
    user,
  };
}

async function getActiveRegionAssignmentBySignature(deps, userId, regionId, assignmentType) {
  const activeAssignments = await deps.userRegionAssignments.listUserRegionAssignmentsByUserId(userId, { activeOnly: true });
  return activeAssignments.find((assignment) => assignment.region_id === regionId && assignment.assignment_type === assignmentType) ?? null;
}

async function expireExistingPrimaryIfNeeded(deps, userId, desiredPrimary, effectiveAt, exceptAssignmentId = null) {
  if (!desiredPrimary) {
    return;
  }

  const activeAssignments = await deps.userRegionAssignments.listUserRegionAssignmentsByUserId(userId, { activeOnly: true });

  for (const assignment of activeAssignments) {
    if (!assignment.is_primary) {
      continue;
    }

    if (exceptAssignmentId && assignment.id === exceptAssignmentId) {
      continue;
    }

    await updateUserRegionAssignmentEndsAt(deps.executor, assignment.id, effectiveAt);
  }
}

export function createRegionAssignmentService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async assignRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionAssignmentServiceDependencies(trx);
        const context = await resolveRegionAssignmentContext(deps, input);
        const activeAssignments = await deps.userRegionAssignments.listUserRegionAssignmentsByUserId(context.user.id, { activeOnly: true });
        const assignmentType = input.assignment_type ?? "member";
        const currentAssignment = await getActiveRegionAssignmentBySignature(deps, context.user.id, context.region.id, assignmentType);
        const desiredPrimary = input.is_primary ?? activeAssignments.length === 0;

        if (currentAssignment && currentAssignment.is_primary === desiredPrimary) {
          return currentAssignment;
        }

        const effectiveAt = input.starts_at ?? new Date().toISOString();

        if (currentAssignment) {
          await updateUserRegionAssignmentEndsAt(deps.executor, currentAssignment.id, effectiveAt);
        }

        await expireExistingPrimaryIfNeeded(deps, context.user.id, desiredPrimary, effectiveAt, currentAssignment?.id ?? null);

        const assignment = await deps.userRegionAssignments.createUserRegionAssignment({
          id: input.id ?? crypto.randomUUID(),
          user_id: context.user.id,
          region_id: context.region.id,
          assignment_type: assignmentType,
          is_primary: desiredPrimary,
          starts_at: effectiveAt,
          ends_at: input.ends_at ?? null,
          assigned_by_user_id: input.assigned_by_user_id ?? null,
        });

        await appendRegionAssignmentAudit(deps, {
          actor_user_id: input.assigned_by_user_id ?? null,
          action: "region.assign",
          entity_id: assignment.id,
          target_user_id: context.user.id,
          summary: "Assigned logical region to user.",
          after_payload: {
            region_id: assignment.region_id,
            assignment_type: assignment.assignment_type,
            is_primary: assignment.is_primary,
          },
        });

        return assignment;
      });
    },

    async changeRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionAssignmentServiceDependencies(trx);
        const existing = await deps.userRegionAssignments.getUserRegionAssignmentById(input.assignment_id);

        if (!existing) {
          throw new RegionAssignmentError("REGION_ASSIGNMENT_NOT_FOUND", "Logical region assignment was not found.");
        }

        if (existing.ends_at) {
          throw new RegionAssignmentError("REGION_ASSIGNMENT_INACTIVE", "Logical region assignment is no longer active.");
        }

        const nextRegionId = input.region_id ?? existing.region_id;
        const nextAssignmentType = input.assignment_type ?? existing.assignment_type;
        const context = await resolveRegionAssignmentContext(deps, {
          user_id: existing.user_id,
          region_id: nextRegionId,
        });

        const duplicate = await getActiveRegionAssignmentBySignature(deps, context.user.id, context.region.id, nextAssignmentType);

        if (duplicate && duplicate.id !== existing.id) {
          throw new RegionAssignmentError(
            "REGION_ASSIGNMENT_ALREADY_ACTIVE",
            "An active logical region assignment already exists for this user, region, and assignment type.",
          );
        }

        const effectiveAt = input.starts_at ?? new Date().toISOString();
        await updateUserRegionAssignmentEndsAt(deps.executor, existing.id, effectiveAt);

        const desiredPrimary = input.is_primary ?? existing.is_primary;
        await expireExistingPrimaryIfNeeded(deps, context.user.id, desiredPrimary, effectiveAt, existing.id);

        const assignment = await deps.userRegionAssignments.createUserRegionAssignment({
          id: input.id ?? crypto.randomUUID(),
          user_id: context.user.id,
          region_id: context.region.id,
          assignment_type: nextAssignmentType,
          is_primary: desiredPrimary,
          starts_at: effectiveAt,
          ends_at: input.ends_at ?? null,
          assigned_by_user_id: input.assigned_by_user_id ?? existing.assigned_by_user_id ?? null,
        });

        await appendRegionAssignmentAudit(deps, {
          actor_user_id: input.assigned_by_user_id ?? existing.assigned_by_user_id ?? null,
          action: "region.change",
          entity_id: assignment.id,
          target_user_id: context.user.id,
          summary: "Changed logical region assignment.",
          before_payload: {
            assignment_id: existing.id,
            region_id: existing.region_id,
            assignment_type: existing.assignment_type,
            is_primary: existing.is_primary,
          },
          after_payload: {
            assignment_id: assignment.id,
            region_id: assignment.region_id,
            assignment_type: assignment.assignment_type,
            is_primary: assignment.is_primary,
          },
        });

        return assignment;
      });
    },

    async endRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionAssignmentServiceDependencies(trx);
        const existing = await deps.userRegionAssignments.getUserRegionAssignmentById(input.assignment_id);

        if (!existing) {
          throw new RegionAssignmentError("REGION_ASSIGNMENT_NOT_FOUND", "Logical region assignment was not found.");
        }

        if (existing.ends_at) {
          return existing;
        }

        const endsAt = input.ends_at ?? new Date().toISOString();
        await updateUserRegionAssignmentEndsAt(deps.executor, existing.id, endsAt);
        const ended = await deps.userRegionAssignments.getUserRegionAssignmentById(existing.id);

        await appendRegionAssignmentAudit(deps, {
          actor_user_id: input.assigned_by_user_id ?? existing.assigned_by_user_id ?? null,
          action: "region.end",
          entity_id: ended.id,
          target_user_id: ended.user_id,
          summary: "Ended logical region assignment.",
          before_payload: { ends_at: existing.ends_at ?? null },
          after_payload: { ends_at: ended.ends_at ?? null },
        });

        return ended;
      });
    },

    async listActiveRegions(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionAssignmentServiceDependencies(trx);
        const user = await deps.users.getUserById(userId, { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          return [];
        }

        return deps.userRegionAssignments.listUserRegionAssignmentsByUserId(userId, { activeOnly: true });
      });
    },
  };
}
