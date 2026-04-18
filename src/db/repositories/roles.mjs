import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const ROLE_COLUMNS = [
  "id",
  "slug",
  "name",
  "description",
  "staff_level",
  "is_system",
  "is_assignable",
  "is_protected",
  "deleted_at",
  "deleted_by_user_id",
  "delete_reason",
  "created_at",
  "updated_at",
];

const MUTABLE_ROLE_FIELDS = new Set(["slug", "name", "description", "staff_level", "is_system", "is_assignable", "is_protected"]);

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeRole(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_system: normalizeBoolean(row.is_system),
    is_assignable: normalizeBoolean(row.is_assignable),
    is_protected: normalizeBoolean(row.is_protected),
  };
}

function buildRolePatch(patch) {
  const values = {};

  for (const [key, value] of Object.entries(patch)) {
    if (MUTABLE_ROLE_FIELDS.has(key) && value !== undefined) {
      values[key] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  values.updated_at = sql`CURRENT_TIMESTAMP`;

  return values;
}

function baseRoleQuery(executor) {
  return executor.selectFrom("roles").select(ROLE_COLUMNS);
}

function applyActiveRoleFilter(query, options = {}) {
  if (options.includeDeleted === true) {
    return query;
  }

  return query.where("deleted_at", "is", null);
}

export function createRoleRepository(executor = getDatabase()) {
  return {
    async createRole(input) {
      await executor
        .insertInto("roles")
        .values({
          id: input.id,
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          staff_level: input.staff_level,
          is_system: input.is_system ?? false,
          is_assignable: input.is_assignable ?? true,
          is_protected: input.is_protected ?? false,
          deleted_at: null,
          deleted_by_user_id: null,
          delete_reason: null,
        })
        .execute();

      return this.getRoleById(input.id, { includeDeleted: true });
    },

    async getRoleById(id, options = {}) {
      const row = await applyActiveRoleFilter(baseRoleQuery(executor).where("id", "=", id), options).executeTakeFirst();
      return normalizeRole(row);
    },

    async getRoleBySlug(slug, options = {}) {
      const row = await applyActiveRoleFilter(baseRoleQuery(executor).where("slug", "=", slug), options).executeTakeFirst();
      return normalizeRole(row);
    },

    async listRoles(options = {}) {
      let query = applyActiveRoleFilter(baseRoleQuery(executor), options)
        .orderBy("staff_level", "desc")
        .orderBy("slug", "asc");

      if (options.is_system !== undefined) {
        query = query.where("is_system", "=", options.is_system);
      }

      if (options.is_assignable !== undefined) {
        query = query.where("is_assignable", "=", options.is_assignable);
      }

      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }

      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }

      const rows = await query.execute();
      return rows.map(normalizeRole);
    },

    async updateRole(id, patch) {
      const values = buildRolePatch(patch);

      if (!values) {
        return this.getRoleById(id, { includeDeleted: true });
      }

      await executor.updateTable("roles").set(values).where("id", "=", id).where("deleted_at", "is", null).execute();
      return this.getRoleById(id, { includeDeleted: true });
    },

    async softDeleteRole(id, options = {}) {
      await executor
        .updateTable("roles")
        .set({
          deleted_at: options.deleted_at ?? sql`CURRENT_TIMESTAMP`,
          deleted_by_user_id: options.deleted_by_user_id ?? null,
          delete_reason: options.delete_reason ?? null,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .execute();

      return this.getRoleById(id, { includeDeleted: true });
    },

    async restoreRole(id) {
      await executor
        .updateTable("roles")
        .set({
          deleted_at: null,
          deleted_by_user_id: null,
          delete_reason: null,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", id)
        .where("deleted_at", "is not", null)
        .execute();

      return this.getRoleById(id, { includeDeleted: true });
    },
  };
}

export { ROLE_COLUMNS, applyActiveRoleFilter, buildRolePatch, normalizeRole };
