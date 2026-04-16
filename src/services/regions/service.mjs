import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createRegionRepository, splitRegionPath } from "../../db/repositories/regions.mjs";

const MAX_REGION_DEPTH = 10;

export class RegionHierarchyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegionHierarchyError";
    this.code = code;
  }
}

function createRegionServiceDependencies(executor) {
  return {
    regions: createRegionRepository(executor),
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildRegionPath(parent, regionId) {
  return parent ? `${parent.path}/${regionId}` : regionId;
}

function buildRegionLevel(parent) {
  return parent ? Number(parent.level) + 1 : 1;
}

function assertDepthLimit(level) {
  if (level < 1 || level > MAX_REGION_DEPTH) {
    throw new RegionHierarchyError("REGION_DEPTH_LIMIT_EXCEEDED", `Logical regions may only be nested ${MAX_REGION_DEPTH} levels deep.`);
  }
}

async function getActiveRegionOrThrow(deps, regionId, code, message) {
  const region = await deps.regions.getRegionById(regionId, { includeDeleted: false });

  if (!region) {
    throw new RegionHierarchyError(code, message);
  }

  return region;
}

async function resolveParentRegion(deps, parentId) {
  if (!parentId) {
    return null;
  }

  return getActiveRegionOrThrow(deps, parentId, "PARENT_REGION_NOT_FOUND", "Parent region is not available.");
}

function assertNotDescendantParent(region, parent) {
  if (!parent) {
    return;
  }

  if (parent.id === region.id) {
    throw new RegionHierarchyError("REGION_PARENT_CYCLE", "A region cannot be parented to itself.");
  }

  const parentLineageIds = splitRegionPath(parent.path);

  if (parentLineageIds.includes(region.id)) {
    throw new RegionHierarchyError("REGION_PARENT_CYCLE", "A region cannot be moved under its own descendant subtree.");
  }
}

export function createRegionService(options = {}) {
  const database = options.database ?? getDatabase();

  return {
    async createRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionServiceDependencies(trx);
        const id = normalizeString(input.id) || crypto.randomUUID();
        const code = normalizeString(input.code);
        const name = normalizeString(input.name);

        if (!code) {
          throw new RegionHierarchyError("REGION_CODE_REQUIRED", "Region code is required.");
        }

        if (!name) {
          throw new RegionHierarchyError("REGION_NAME_REQUIRED", "Region name is required.");
        }

        const parent = await resolveParentRegion(deps, normalizeString(input.parent_id));
        const level = buildRegionLevel(parent);
        assertDepthLimit(level);

        return deps.regions.createRegion({
          id,
          code,
          name,
          parent_id: parent?.id ?? null,
          level,
          path: buildRegionPath(parent, id),
          sort_order: input.sort_order ?? 0,
          is_active: input.is_active ?? true,
          deleted_at: input.deleted_at ?? null,
        });
      });
    },

    async updateRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionServiceDependencies(trx);
        const regionId = normalizeString(input.region_id);

        if (!regionId) {
          throw new RegionHierarchyError("REGION_NOT_FOUND", "Region id is required.");
        }

        await getActiveRegionOrThrow(deps, regionId, "REGION_NOT_FOUND", "Region is not available.");

        const patch = {};

        if (input.code !== undefined) {
          const code = normalizeString(input.code);

          if (!code) {
            throw new RegionHierarchyError("REGION_CODE_REQUIRED", "Region code is required.");
          }

          patch.code = code;
        }

        if (input.name !== undefined) {
          const name = normalizeString(input.name);

          if (!name) {
            throw new RegionHierarchyError("REGION_NAME_REQUIRED", "Region name is required.");
          }

          patch.name = name;
        }

        if (input.sort_order !== undefined) {
          patch.sort_order = input.sort_order;
        }

        if (input.is_active !== undefined) {
          patch.is_active = input.is_active;
        }

        return deps.regions.updateRegion(regionId, patch);
      });
    },

    async reparentRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionServiceDependencies(trx);
        const regionId = normalizeString(input.region_id);

        if (!regionId) {
          throw new RegionHierarchyError("REGION_NOT_FOUND", "Region id is required.");
        }

        const region = await getActiveRegionOrThrow(deps, regionId, "REGION_NOT_FOUND", "Region is not available.");
        const nextParent = await resolveParentRegion(deps, normalizeString(input.parent_id));
        assertNotDescendantParent(region, nextParent);

        const nextLevel = buildRegionLevel(nextParent);
        const nextPath = buildRegionPath(nextParent, region.id);
        const subtree = await deps.regions.listRegionSubtree(region.id, { includeDeleted: true });

        for (const entry of subtree) {
          const relativeDepth = Number(entry.level) - Number(region.level);
          assertDepthLimit(nextLevel + relativeDepth);
        }

        const currentPathPrefix = `${region.path}/`;

        await deps.regions.updateRegion(region.id, {
          parent_id: nextParent?.id ?? null,
          level: nextLevel,
          path: nextPath,
        });

        for (const entry of subtree) {
          if (entry.id === region.id) {
            continue;
          }

          const nextEntryPath = entry.path === region.path ? nextPath : `${nextPath}/${entry.path.slice(currentPathPrefix.length)}`;
          const nextEntryLevel = nextLevel + (Number(entry.level) - Number(region.level));

          await deps.regions.updateRegion(entry.id, {
            level: nextEntryLevel,
            path: nextEntryPath,
          });
        }

        return deps.regions.listRegionSubtree(region.id, { includeDeleted: true });
      });
    },
  };
}

export { MAX_REGION_DEPTH };
