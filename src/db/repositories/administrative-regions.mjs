import { sql } from "kysely";

import { getDatabase } from "../index.mjs";

const ADMINISTRATIVE_REGION_COLUMNS = [
  "id",
  "code",
  "name",
  "type",
  "parent_id",
  "path",
  "province_code",
  "regency_code",
  "district_code",
  "village_code",
  "is_active",
  "created_at",
  "updated_at",
];

const MUTABLE_ADMINISTRATIVE_REGION_FIELDS = new Set([
  "code",
  "name",
  "type",
  "parent_id",
  "path",
  "province_code",
  "regency_code",
  "district_code",
  "village_code",
  "is_active",
]);

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Boolean(value);
}

function normalizeAdministrativeRegion(row) {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    is_active: normalizeBoolean(row.is_active),
  };
}

function buildAdministrativeRegionPatch(patch) {
  const values = {};

  for (const [key, value] of Object.entries(patch)) {
    if (MUTABLE_ADMINISTRATIVE_REGION_FIELDS.has(key) && value !== undefined) {
      values[key] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  values.updated_at = sql`CURRENT_TIMESTAMP`;
  return values;
}

function baseAdministrativeRegionQuery(executor) {
  return executor.selectFrom("administrative_regions").select(ADMINISTRATIVE_REGION_COLUMNS);
}

function splitAdministrativeRegionPath(path) {
  if (typeof path !== "string") {
    return [];
  }

  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function createAdministrativeRegionRepository(executor = getDatabase()) {
  return {
    async createAdministrativeRegion(input) {
      await executor.insertInto("administrative_regions").values({
        id: input.id,
        code: input.code,
        name: input.name,
        type: input.type,
        parent_id: input.parent_id ?? null,
        path: input.path,
        province_code: input.province_code ?? null,
        regency_code: input.regency_code ?? null,
        district_code: input.district_code ?? null,
        village_code: input.village_code ?? null,
        is_active: input.is_active ?? true,
      }).execute();

      return this.getAdministrativeRegionById(input.id);
    },

    async getAdministrativeRegionById(id) {
      const row = await baseAdministrativeRegionQuery(executor).where("id", "=", id).executeTakeFirst();
      return normalizeAdministrativeRegion(row);
    },

    async getAdministrativeRegionByCode(code) {
      const row = await baseAdministrativeRegionQuery(executor).where("code", "=", code).executeTakeFirst();
      return normalizeAdministrativeRegion(row);
    },

    async listAdministrativeRegions(options = {}) {
      let query = baseAdministrativeRegionQuery(executor)
        .orderBy("path", "asc")
        .orderBy("code", "asc");

      if (options.parent_id === null) {
        query = query.where("parent_id", "is", null);
      } else if (options.parent_id !== undefined) {
        query = query.where("parent_id", "=", options.parent_id);
      }

      if (options.type !== undefined) {
        query = query.where("type", "=", options.type);
      }

      if (options.is_active !== undefined) {
        query = query.where("is_active", "=", options.is_active);
      }

      if (options.limit !== undefined) query = query.limit(options.limit);
      if (options.offset !== undefined) query = query.offset(options.offset);

      const rows = await query.execute();
      return rows.map(normalizeAdministrativeRegion);
    },

    async listAdministrativeRegionChildren(parentId, options = {}) {
      return this.listAdministrativeRegions({
        ...options,
        parent_id: parentId,
      });
    },

    async listAdministrativeRegionLineage(regionId) {
      const region = await this.getAdministrativeRegionById(regionId);

      if (!region) {
        return [];
      }

      const lineageIds = splitAdministrativeRegionPath(region.path);

      if (lineageIds.length === 0) {
        return [region];
      }

      const regions = await this.listAdministrativeRegions();
      const byId = new Map(regions.map((entry) => [entry.id, entry]));

      return lineageIds.map((id) => byId.get(id)).filter(Boolean);
    },

    async listAdministrativeRegionSubtree(regionId, options = {}) {
      const region = await this.getAdministrativeRegionById(regionId);

      if (!region) {
        return [];
      }

      const regionPathPrefix = `${region.path}/`;
      const regions = await this.listAdministrativeRegions({ is_active: options.is_active });

      return regions
        .filter((entry) => entry.id === region.id || entry.path === region.path || entry.path.startsWith(regionPathPrefix))
        .sort(
          (left, right) =>
            String(left.path ?? "").localeCompare(String(right.path ?? "")) ||
            String(left.code ?? "").localeCompare(String(right.code ?? "")),
        );
    },

    async updateAdministrativeRegion(id, patch) {
      const values = buildAdministrativeRegionPatch(patch);

      if (!values) {
        return this.getAdministrativeRegionById(id);
      }

      await executor.updateTable("administrative_regions").set(values).where("id", "=", id).execute();
      return this.getAdministrativeRegionById(id);
    },
  };
}

export {
  ADMINISTRATIVE_REGION_COLUMNS,
  buildAdministrativeRegionPatch,
  normalizeAdministrativeRegion,
  splitAdministrativeRegionPath,
};
