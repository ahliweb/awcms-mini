import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createJobLevelRepository } from "../../db/repositories/job-levels.mjs";
import { createJobTitleRepository } from "../../db/repositories/job-titles.mjs";
import { createUserJobRepository } from "../../db/repositories/user-jobs.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";
import { createAuditService } from "../audit/service.mjs";

export class JobAssignmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JobAssignmentError";
    this.code = code;
  }
}

function createJobServiceDependencies(executor) {
  return {
    users: createUserRepository(executor),
    jobLevels: createJobLevelRepository(executor),
    jobTitles: createJobTitleRepository(executor),
    userJobs: createUserJobRepository(executor),
    audit: createAuditService({ database: executor }),
    executor,
  };
}

async function appendJobAudit(deps, input) {
  await deps.audit.append({
    actor_user_id: input.actor_user_id ?? null,
    action: input.action,
    entity_type: "job_assignment",
    entity_id: input.entity_id ?? null,
    target_user_id: input.target_user_id ?? null,
    summary: input.summary,
    before_payload: input.before_payload ?? null,
    after_payload: input.after_payload ?? null,
    metadata: input.metadata ?? {},
  });
}

async function updateUserJobEndsAt(executor, id, endsAt) {
  await executor.updateTable("user_jobs").set({ ends_at: endsAt }).where("id", "=", id).where("ends_at", "is", null).execute();
}

async function getActivePrimaryJobByUserId(deps, userId) {
  const activeJobs = await deps.userJobs.listUserJobsByUserId(userId, { activeOnly: true });
  return activeJobs.find((job) => job.is_primary) ?? null;
}

async function resolveJobContext(deps, input) {
  const user = await deps.users.getUserById(input.user_id, { includeDeleted: true });

  if (!user || user.deleted_at || user.status === "deleted") {
    throw new JobAssignmentError("USER_NOT_FOUND", "User is not available for job assignment.");
  }

  const jobLevel = await deps.jobLevels.getJobLevelById(input.job_level_id, { includeDeleted: false });

  if (!jobLevel) {
    throw new JobAssignmentError("JOB_LEVEL_NOT_FOUND", "Job level is not available for assignment.");
  }

  let jobTitle = null;

  if (input.job_title_id) {
    jobTitle = await deps.jobTitles.getJobTitleById(input.job_title_id, { includeDeleted: false });

    if (!jobTitle || jobTitle.is_active === false) {
      throw new JobAssignmentError("JOB_TITLE_NOT_FOUND", "Job title is not available for assignment.");
    }

    if (jobTitle.job_level_id !== jobLevel.id) {
      throw new JobAssignmentError("JOB_TITLE_LEVEL_MISMATCH", "Job title does not belong to the selected job level.");
    }
  }

  let supervisor = null;

  if (input.supervisor_user_id) {
    supervisor = await deps.users.getUserById(input.supervisor_user_id, { includeDeleted: true });

    if (!supervisor || supervisor.deleted_at || supervisor.status === "deleted") {
      throw new JobAssignmentError("SUPERVISOR_NOT_FOUND", "Supervisor is not available for assignment.");
    }
  }

  return {
    user,
    jobLevel,
    jobTitle,
    supervisor,
  };
}

async function assertNoSupervisorCycle(deps, userId, supervisorUserId) {
  if (!supervisorUserId) {
    return;
  }

  if (userId === supervisorUserId) {
    throw new JobAssignmentError("SUPERVISOR_CYCLE", "Supervisor chain cannot reference the same user.");
  }

  const visited = new Set([userId]);
  let cursor = supervisorUserId;

  while (cursor) {
    if (visited.has(cursor)) {
      throw new JobAssignmentError("SUPERVISOR_CYCLE", "Supervisor chain would create a cycle.");
    }

    visited.add(cursor);

    const activePrimary = await getActivePrimaryJobByUserId(deps, cursor);
    cursor = activePrimary?.supervisor_user_id ?? null;
  }
}

async function expireExistingPrimaryIfNeeded(deps, userId, desiredPrimary, effectiveAt, exceptJobId = null) {
  if (!desiredPrimary) {
    return;
  }

  const activeJobs = await deps.userJobs.listUserJobsByUserId(userId, { activeOnly: true });

  for (const job of activeJobs) {
    if (!job.is_primary) {
      continue;
    }

    if (exceptJobId && job.id === exceptJobId) {
      continue;
    }

    await updateUserJobEndsAt(deps.executor, job.id, effectiveAt);
  }
}

export function createJobsService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async assignJob(input) {
      return withTransaction(database, async (trx) => {
        const deps = createJobServiceDependencies(trx);
        const context = await resolveJobContext(deps, input);
        await assertNoSupervisorCycle(deps, context.user.id, input.supervisor_user_id ?? null);

        const activeJobs = await deps.userJobs.listUserJobsByUserId(context.user.id, { activeOnly: true });
        const desiredPrimary = input.is_primary ?? activeJobs.length === 0;
        const effectiveAt = input.starts_at ?? new Date().toISOString();

        await expireExistingPrimaryIfNeeded(deps, context.user.id, desiredPrimary, effectiveAt);

        const assignment = await deps.userJobs.createUserJob({
          id: input.id ?? crypto.randomUUID(),
          user_id: context.user.id,
          job_level_id: context.jobLevel.id,
          job_title_id: context.jobTitle?.id ?? null,
          supervisor_user_id: context.supervisor?.id ?? null,
          employment_status: input.employment_status ?? "active",
          starts_at: effectiveAt,
          ends_at: input.ends_at ?? null,
          is_primary: desiredPrimary,
          assigned_by_user_id: input.assigned_by_user_id ?? null,
          notes: input.notes ?? null,
        });

        await appendJobAudit(deps, {
          actor_user_id: input.assigned_by_user_id ?? null,
          action: "job.assign",
          entity_id: assignment.id,
          target_user_id: context.user.id,
          summary: "Assigned job to user.",
          after_payload: {
            job_level_id: assignment.job_level_id,
            job_title_id: assignment.job_title_id,
            supervisor_user_id: assignment.supervisor_user_id,
            is_primary: assignment.is_primary,
          },
        });

        return assignment;
      });
    },

    async changeJob(input) {
      return withTransaction(database, async (trx) => {
        const deps = createJobServiceDependencies(trx);
        const existing = await deps.userJobs.getUserJobById(input.job_id);

        if (!existing) {
          throw new JobAssignmentError("JOB_ASSIGNMENT_NOT_FOUND", "Job assignment was not found.");
        }

        if (existing.ends_at) {
          throw new JobAssignmentError("JOB_ASSIGNMENT_INACTIVE", "Job assignment is no longer active.");
        }

        const context = await resolveJobContext(deps, {
          user_id: existing.user_id,
          job_level_id: input.job_level_id,
          job_title_id: input.job_title_id,
          supervisor_user_id: input.supervisor_user_id,
        });

        await assertNoSupervisorCycle(deps, context.user.id, input.supervisor_user_id ?? null);

        const effectiveAt = input.starts_at ?? new Date().toISOString();
        await updateUserJobEndsAt(deps.executor, existing.id, effectiveAt);

        const desiredPrimary = input.is_primary ?? existing.is_primary;
        await expireExistingPrimaryIfNeeded(deps, context.user.id, desiredPrimary, effectiveAt, existing.id);

        const assignment = await deps.userJobs.createUserJob({
          id: input.id ?? crypto.randomUUID(),
          user_id: context.user.id,
          job_level_id: context.jobLevel.id,
          job_title_id: context.jobTitle?.id ?? null,
          supervisor_user_id: context.supervisor?.id ?? null,
          employment_status: input.employment_status ?? existing.employment_status,
          starts_at: effectiveAt,
          ends_at: input.ends_at ?? null,
          is_primary: desiredPrimary,
          assigned_by_user_id: input.assigned_by_user_id ?? existing.assigned_by_user_id ?? null,
          notes: input.notes ?? existing.notes ?? null,
        });

        await appendJobAudit(deps, {
          actor_user_id: input.assigned_by_user_id ?? existing.assigned_by_user_id ?? null,
          action: "job.change",
          entity_id: assignment.id,
          target_user_id: context.user.id,
          summary: "Changed user job assignment.",
          before_payload: {
            job_id: existing.id,
            job_level_id: existing.job_level_id,
            job_title_id: existing.job_title_id,
            supervisor_user_id: existing.supervisor_user_id,
            is_primary: existing.is_primary,
          },
          after_payload: {
            job_id: assignment.id,
            job_level_id: assignment.job_level_id,
            job_title_id: assignment.job_title_id,
            supervisor_user_id: assignment.supervisor_user_id,
            is_primary: assignment.is_primary,
          },
        });

        return assignment;
      });
    },

    async endJob(input) {
      return withTransaction(database, async (trx) => {
        const deps = createJobServiceDependencies(trx);
        const existing = await deps.userJobs.getUserJobById(input.job_id);

        if (!existing) {
          throw new JobAssignmentError("JOB_ASSIGNMENT_NOT_FOUND", "Job assignment was not found.");
        }

        if (existing.ends_at) {
          return existing;
        }

        const endsAt = input.ends_at ?? new Date().toISOString();
        await updateUserJobEndsAt(deps.executor, existing.id, endsAt);
        const ended = await deps.userJobs.getUserJobById(existing.id);

        await appendJobAudit(deps, {
          actor_user_id: input.assigned_by_user_id ?? existing.assigned_by_user_id ?? null,
          action: "job.end",
          entity_id: ended.id,
          target_user_id: ended.user_id,
          summary: "Ended user job assignment.",
          before_payload: { ends_at: existing.ends_at ?? null },
          after_payload: { ends_at: ended.ends_at ?? null },
        });

        return ended;
      });
    },

    async listActiveJobs(userId) {
      return withTransaction(database, async (trx) => {
        const deps = createJobServiceDependencies(trx);
        const user = await deps.users.getUserById(userId, { includeDeleted: true });

        if (!user || user.deleted_at || user.status === "deleted") {
          return [];
        }

        return deps.userJobs.listUserJobsByUserId(userId, { activeOnly: true });
      });
    },
  };
}
