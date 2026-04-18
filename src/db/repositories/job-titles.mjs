import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const JOB_TITLE_COLUMNS = ["id", "job_level_id", "code", "name", "description", "is_active", "deleted_at", "deleted_by_user_id", "delete_reason", "created_at", "updated_at"];
const MUTABLE_JOB_TITLE_FIELDS = new Set(["job_level_id", "code", "name", "description", "is_active"]);

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeJobTitle(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_active: normalizeBoolean(row.is_active),
  };
}

function buildJobTitlePatch(patch) {
  const values = {};

  for (const [key, value] of Object.entries(patch)) {
    if (MUTABLE_JOB_TITLE_FIELDS.has(key) && value !== undefined) {
      values[key] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  values.updated_at = sql`CURRENT_TIMESTAMP`;
  return values;
}

function baseJobTitleQuery(executor) {
  return executor.selectFrom("job_titles").select(JOB_TITLE_COLUMNS);
}

function applyActiveJobTitleFilter(query, options = {}) {
  if (options.includeDeleted === true) {
    return query;
  }

  return query.where("deleted_at", "is", null);
}

export function createJobTitleRepository(executor = getDatabase()) {
  return {
    async createJobTitle(input) {
      await executor.insertInto("job_titles").values({
        id: input.id,
        job_level_id: input.job_level_id,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        is_active: input.is_active ?? true,
        deleted_at: null,
        deleted_by_user_id: null,
        delete_reason: null,
      }).execute();

      return this.getJobTitleById(input.id, { includeDeleted: true });
    },

    async getJobTitleById(id, options = {}) {
      const row = await applyActiveJobTitleFilter(baseJobTitleQuery(executor).where("id", "=", id), options).executeTakeFirst();
      return normalizeJobTitle(row);
    },

    async getJobTitleByCode(code, options = {}) {
      const row = await applyActiveJobTitleFilter(baseJobTitleQuery(executor).where("code", "=", code), options).executeTakeFirst();
      return normalizeJobTitle(row);
    },

    async listJobTitles(options = {}) {
      let query = applyActiveJobTitleFilter(baseJobTitleQuery(executor), options)
        .orderBy("job_level_id", "asc")
        .orderBy("code", "asc");

      if (options.job_level_id !== undefined) {
        query = query.where("job_level_id", "=", options.job_level_id);
      }

      if (options.is_active !== undefined) {
        query = query.where("is_active", "=", options.is_active);
      }

      if (options.limit !== undefined) query = query.limit(options.limit);
      if (options.offset !== undefined) query = query.offset(options.offset);

      const rows = await query.execute();
      return rows.map(normalizeJobTitle);
    },

    async updateJobTitle(id, patch) {
      const values = buildJobTitlePatch(patch);

      if (!values) {
        return this.getJobTitleById(id, { includeDeleted: true });
      }

      await executor.updateTable("job_titles").set(values).where("id", "=", id).where("deleted_at", "is", null).execute();
      return this.getJobTitleById(id, { includeDeleted: true });
    },

    async softDeleteJobTitle(id, options = {}) {
      await executor
        .updateTable("job_titles")
        .set({
          deleted_at: options.deleted_at ?? sql`CURRENT_TIMESTAMP`,
          deleted_by_user_id: options.deleted_by_user_id ?? null,
          delete_reason: options.delete_reason ?? null,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .execute();

      return this.getJobTitleById(id, { includeDeleted: true });
    },

    async restoreJobTitle(id) {
      await executor
        .updateTable("job_titles")
        .set({
          deleted_at: null,
          deleted_by_user_id: null,
          delete_reason: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", id)
        .where("deleted_at", "is not", null)
        .execute();

      return this.getJobTitleById(id, { includeDeleted: true });
    },
  };
}

export { JOB_TITLE_COLUMNS, applyActiveJobTitleFilter, buildJobTitlePatch, normalizeJobTitle };
