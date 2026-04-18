import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const JOB_LEVEL_COLUMNS = ["id", "code", "name", "rank_order", "description", "is_system", "deleted_at", "deleted_by_user_id", "delete_reason", "created_at", "updated_at"];
const MUTABLE_JOB_LEVEL_FIELDS = new Set(["code", "name", "rank_order", "description", "is_system"]);

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeJobLevel(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_system: normalizeBoolean(row.is_system),
  };
}

function buildJobLevelPatch(patch) {
  const values = {};

  for (const [key, value] of Object.entries(patch)) {
    if (MUTABLE_JOB_LEVEL_FIELDS.has(key) && value !== undefined) {
      values[key] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  values.updated_at = sql`CURRENT_TIMESTAMP`;
  return values;
}

function baseJobLevelQuery(executor) {
  return executor.selectFrom("job_levels").select(JOB_LEVEL_COLUMNS);
}

function applyActiveJobLevelFilter(query, options = {}) {
  if (options.includeDeleted === true) {
    return query;
  }

  return query.where("deleted_at", "is", null);
}

export function createJobLevelRepository(executor = getDatabase()) {
  return {
    async createJobLevel(input) {
      await executor.insertInto("job_levels").values({
        id: input.id,
        code: input.code,
        name: input.name,
        rank_order: input.rank_order,
        description: input.description ?? null,
        is_system: input.is_system ?? false,
        deleted_at: null,
        deleted_by_user_id: null,
        delete_reason: null,
      }).execute();

      return this.getJobLevelById(input.id, { includeDeleted: true });
    },

    async getJobLevelById(id, options = {}) {
      const row = await applyActiveJobLevelFilter(baseJobLevelQuery(executor).where("id", "=", id), options).executeTakeFirst();
      return normalizeJobLevel(row);
    },

    async getJobLevelByCode(code, options = {}) {
      const row = await applyActiveJobLevelFilter(baseJobLevelQuery(executor).where("code", "=", code), options).executeTakeFirst();
      return normalizeJobLevel(row);
    },

    async listJobLevels(options = {}) {
      let query = applyActiveJobLevelFilter(baseJobLevelQuery(executor), options)
        .orderBy("rank_order", "desc")
        .orderBy("code", "asc");

      if (options.is_system !== undefined) {
        query = query.where("is_system", "=", options.is_system);
      }

      if (options.limit !== undefined) query = query.limit(options.limit);
      if (options.offset !== undefined) query = query.offset(options.offset);

      const rows = await query.execute();
      return rows.map(normalizeJobLevel);
    },

    async updateJobLevel(id, patch) {
      const values = buildJobLevelPatch(patch);

      if (!values) {
        return this.getJobLevelById(id, { includeDeleted: true });
      }

      await executor.updateTable("job_levels").set(values).where("id", "=", id).where("deleted_at", "is", null).execute();
      return this.getJobLevelById(id, { includeDeleted: true });
    },

    async softDeleteJobLevel(id, options = {}) {
      await executor
        .updateTable("job_levels")
        .set({
          deleted_at: options.deleted_at ?? sql`CURRENT_TIMESTAMP`,
          deleted_by_user_id: options.deleted_by_user_id ?? null,
          delete_reason: options.delete_reason ?? null,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .execute();

      return this.getJobLevelById(id, { includeDeleted: true });
    },

    async restoreJobLevel(id) {
      await executor
        .updateTable("job_levels")
        .set({
          deleted_at: null,
          deleted_by_user_id: null,
          delete_reason: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", id)
        .where("deleted_at", "is not", null)
        .execute();

      return this.getJobLevelById(id, { includeDeleted: true });
    },
  };
}

export { JOB_LEVEL_COLUMNS, applyActiveJobLevelFilter, buildJobLevelPatch, normalizeJobLevel };
