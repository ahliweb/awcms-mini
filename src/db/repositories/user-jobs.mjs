import { getDatabase } from "../index.mjs";

const USER_JOB_COLUMNS = [
  "id",
  "user_id",
  "job_level_id",
  "job_title_id",
  "supervisor_user_id",
  "employment_status",
  "starts_at",
  "ends_at",
  "is_primary",
  "assigned_by_user_id",
  "notes",
  "created_at",
];

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeUserJob(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_primary: normalizeBoolean(row.is_primary),
  };
}

function baseUserJobQuery(executor) {
  return executor.selectFrom("user_jobs").select(USER_JOB_COLUMNS);
}

export function createUserJobRepository(executor = getDatabase()) {
  return {
    async createUserJob(input) {
      await executor.insertInto("user_jobs").values({
        id: input.id,
        user_id: input.user_id,
        job_level_id: input.job_level_id,
        job_title_id: input.job_title_id ?? null,
        supervisor_user_id: input.supervisor_user_id ?? null,
        employment_status: input.employment_status ?? "active",
        starts_at: input.starts_at,
        ends_at: input.ends_at ?? null,
        is_primary: input.is_primary ?? false,
        assigned_by_user_id: input.assigned_by_user_id ?? null,
        notes: input.notes ?? null,
        created_at: input.created_at ?? undefined,
      }).execute();

      return this.getUserJobById(input.id);
    },

    async getUserJobById(id) {
      const row = await baseUserJobQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizeUserJob(row);
    },

    async listUserJobsByUserId(userId, options = {}) {
      let query = baseUserJobQuery(executor)
        .where("user_id", "=", userId)
        .orderBy("is_primary", "desc")
        .orderBy("starts_at", "desc")
        .orderBy("id", "asc");

      if (options.activeOnly === true) {
        query = query.where("ends_at", "is", null);
      }

      const rows = await query.execute();
      return rows.map(normalizeUserJob);
    },

    async listActivePrimaryJobs() {
      const rows = await baseUserJobQuery(executor)
        .where("is_primary", "=", true)
        .where("ends_at", "is", null)
        .orderBy("user_id", "asc")
        .execute();

      return rows.map(normalizeUserJob);
    },

    async listUserJobsBySupervisorId(supervisorUserId, options = {}) {
      let query = baseUserJobQuery(executor)
        .where("supervisor_user_id", "=", supervisorUserId)
        .orderBy("user_id", "asc")
        .orderBy("starts_at", "desc");

      if (options.activeOnly === true) {
        query = query.where("ends_at", "is", null);
      }

      const rows = await query.execute();
      return rows.map(normalizeUserJob);
    },
  };
}

export { USER_JOB_COLUMNS, normalizeUserJob };
