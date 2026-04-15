import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const PERMISSION_COLUMNS = [
  "id",
  "code",
  "domain",
  "resource",
  "action",
  "description",
  "is_protected",
  "created_at",
];

const MUTABLE_PERMISSION_FIELDS = new Set(["code", "domain", "resource", "action", "description", "is_protected"]);

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizePermission(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_protected: normalizeBoolean(row.is_protected),
  };
}

function buildPermissionPatch(patch) {
  const values = {};

  for (const [key, value] of Object.entries(patch)) {
    if (MUTABLE_PERMISSION_FIELDS.has(key) && value !== undefined) {
      values[key] = value;
    }
  }

  return Object.keys(values).length === 0 ? undefined : values;
}

function basePermissionQuery(executor) {
  return executor.selectFrom("permissions").select(PERMISSION_COLUMNS);
}

export function createPermissionRepository(executor = getDatabase()) {
  return {
    async createPermission(input) {
      await executor
        .insertInto("permissions")
        .values({
          id: input.id,
          code: input.code,
          domain: input.domain,
          resource: input.resource,
          action: input.action,
          description: input.description ?? null,
          is_protected: input.is_protected ?? false,
          created_at: input.created_at ?? undefined,
        })
        .execute();

      return this.getPermissionById(input.id);
    },

    async getPermissionById(id) {
      const row = await basePermissionQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizePermission(row);
    },

    async getPermissionByCode(code) {
      const row = await basePermissionQuery(executor).where("code", "=", code).executeTakeFirst();
      return normalizePermission(row);
    },

    async listPermissions(options = {}) {
      let query = basePermissionQuery(executor)
        .orderBy("domain", "asc")
        .orderBy("resource", "asc")
        .orderBy("action", "asc");

      if (options.domain !== undefined) {
        query = query.where("domain", "=", options.domain);
      }

      if (options.resource !== undefined) {
        query = query.where("resource", "=", options.resource);
      }

      if (options.action !== undefined) {
        query = query.where("action", "=", options.action);
      }

      if (options.is_protected !== undefined) {
        query = query.where("is_protected", "=", options.is_protected);
      }

      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }

      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }

      const rows = await query.execute();
      return rows.map(normalizePermission);
    },

    async updatePermission(id, patch) {
      const values = buildPermissionPatch(patch);

      if (!values) {
        return this.getPermissionById(id);
      }

      await executor.updateTable("permissions").set(values).where("id", "=", id).execute();
      return this.getPermissionById(id);
    },
  };
}

export { PERMISSION_COLUMNS, buildPermissionPatch, normalizePermission };
