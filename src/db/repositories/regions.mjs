import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const REGION_COLUMNS = ["id", "code", "name", "parent_id", "level", "path", "sort_order", "is_active", "deleted_at", "created_at", "updated_at"];
const MUTABLE_REGION_FIELDS = new Set(["code", "name", "parent_id", "level", "path", "sort_order", "is_active", "deleted_at"]);

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeRegion(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_active: normalizeBoolean(row.is_active),
  };
}

function buildRegionPatch(patch) {
  const values = {};

  for (const [key, value] of Object.entries(patch)) {
    if (MUTABLE_REGION_FIELDS.has(key) && value !== undefined) {
      values[key] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  values.updated_at = sql`CURRENT_TIMESTAMP`;
  return values;
}

function baseRegionQuery(executor) {
  return executor.selectFrom("regions").select(REGION_COLUMNS);
}

function applyActiveRegionFilter(query, options = {}) {
  if (options.includeDeleted === true) {
    return query;
  }

  return query.where("deleted_at", "is", null);
}

function splitRegionPath(path) {
  if (typeof path !== "string") {
    return [];
  }

  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function createRegionRepository(executor = getDatabase()) {
  return {
    async createRegion(input) {
      await executor.insertInto("regions").values({
        id: input.id,
        code: input.code,
        name: input.name,
        parent_id: input.parent_id ?? null,
        level: input.level,
        path: input.path,
        sort_order: input.sort_order ?? 0,
        is_active: input.is_active ?? true,
        deleted_at: input.deleted_at ?? null,
      }).execute();

      return this.getRegionById(input.id, { includeDeleted: true });
    },

    async getRegionById(id, options = {}) {
      const row = await applyActiveRegionFilter(baseRegionQuery(executor).where("id", "=", id), options).executeTakeFirst();
      return normalizeRegion(row);
    },

    async getRegionByCode(code, options = {}) {
      const row = await applyActiveRegionFilter(baseRegionQuery(executor).where("code", "=", code), options).executeTakeFirst();
      return normalizeRegion(row);
    },

    async listRegions(options = {}) {
      let query = applyActiveRegionFilter(baseRegionQuery(executor), options)
        .orderBy("level", "asc")
        .orderBy("sort_order", "asc")
        .orderBy("code", "asc");

      if (options.parent_id === null) {
        query = query.where("parent_id", "is", null);
      } else if (options.parent_id !== undefined) {
        query = query.where("parent_id", "=", options.parent_id);
      }

      if (options.is_active !== undefined) {
        query = query.where("is_active", "=", options.is_active);
      }

      if (options.limit !== undefined) query = query.limit(options.limit);
      if (options.offset !== undefined) query = query.offset(options.offset);

      const rows = await query.execute();
      return rows.map(normalizeRegion);
    },

    async listRegionChildren(parentId, options = {}) {
      return this.listRegions({
        ...options,
        parent_id: parentId,
      });
    },

    async listRegionLineage(regionId, options = {}) {
      const region = await this.getRegionById(regionId, options);

      if (!region) {
        return [];
      }

      const lineageIds = splitRegionPath(region.path);

      if (lineageIds.length === 0) {
        return [region];
      }

      const regions = await this.listRegions({
        includeDeleted: options.includeDeleted,
        limit: options.limit,
        offset: options.offset,
      });
      const byId = new Map(regions.map((entry) => [entry.id, entry]));

      return lineageIds.map((id) => byId.get(id)).filter(Boolean);
    },

    async listRegionSubtree(regionId, options = {}) {
      const region = await this.getRegionById(regionId, options);

      if (!region) {
        return [];
      }

      const regionPathPrefix = `${region.path}/`;
      const regions = await this.listRegions({ includeDeleted: options.includeDeleted, is_active: options.is_active });

      return regions
        .filter((entry) => entry.id === region.id || entry.path === region.path || entry.path.startsWith(regionPathPrefix))
        .sort(
          (left, right) =>
            Number(left.level ?? 0) - Number(right.level ?? 0) ||
            String(left.path ?? "").localeCompare(String(right.path ?? "")) ||
            Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0) ||
            String(left.code ?? "").localeCompare(String(right.code ?? "")),
        );
    },

    async updateRegion(id, patch) {
      const values = buildRegionPatch(patch);

      if (!values) {
        return this.getRegionById(id, { includeDeleted: true });
      }

      await executor.updateTable("regions").set(values).where("id", "=", id).execute();
      return this.getRegionById(id, { includeDeleted: true });
    },
  };
}

export { REGION_COLUMNS, applyActiveRegionFilter, buildRegionPatch, normalizeRegion, splitRegionPath };
