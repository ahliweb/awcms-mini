import { getDatabase, withTransaction } from "../../db/index.mjs";
import { createRegionRepository, splitRegionPath } from "../../db/repositories/regions.mjs";
import { createAuditService } from "../audit/service.mjs";

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
    audit: createAuditService({ database: executor }),
  };
}

async function appendRegionAudit(deps, input) {
  await deps.audit.append({
    actor_user_id: input.actor_user_id ?? null,
    action: input.action,
    entity_type: "region",
    entity_id: input.entity_id ?? null,
    summary: input.summary,
    before_payload: input.before_payload ?? null,
    after_payload: input.after_payload ?? null,
    metadata: input.metadata ?? {},
  });
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

        const region = await deps.regions.createRegion({
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

        await appendRegionAudit(deps, {
          action: "region.create",
          entity_id: region.id,
          summary: "Created logical region.",
          after_payload: {
            code: region.code,
            name: region.name,
            parent_id: region.parent_id,
            level: region.level,
            path: region.path,
          },
        });

        return region;
      });
    },

    async updateRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionServiceDependencies(trx);
        const regionId = normalizeString(input.region_id);

        if (!regionId) {
          throw new RegionHierarchyError("REGION_NOT_FOUND", "Region id is required.");
        }

        const existing = await getActiveRegionOrThrow(deps, regionId, "REGION_NOT_FOUND", "Region is not available.");

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

        const region = await deps.regions.updateRegion(regionId, patch);

        await appendRegionAudit(deps, {
          action: "region.update",
          entity_id: region.id,
          summary: "Updated logical region.",
          before_payload: {
            code: existing.code,
            name: existing.name,
            sort_order: existing.sort_order,
            is_active: existing.is_active,
          },
          after_payload: {
            code: region.code,
            name: region.name,
            sort_order: region.sort_order,
            is_active: region.is_active,
          },
        });

        return region;
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

        const updatedSubtree = await deps.regions.listRegionSubtree(region.id, { includeDeleted: true });

        await appendRegionAudit(deps, {
          action: "region.reparent",
          entity_id: region.id,
          summary: "Reparented logical region subtree.",
          before_payload: {
            parent_id: region.parent_id,
            level: region.level,
            path: region.path,
          },
          after_payload: {
            parent_id: nextParent?.id ?? null,
            level: nextLevel,
            path: nextPath,
          },
          metadata: {
            subtree_region_ids: updatedSubtree.map((entry) => entry.id),
          },
        });

        return updatedSubtree;
      });
    },

    async softDeleteRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionServiceDependencies(trx);
        const regionId = normalizeString(input.region_id);

        if (!regionId) {
          throw new RegionHierarchyError("REGION_NOT_FOUND", "Region id is required.");
        }

        const region = await getActiveRegionOrThrow(deps, regionId, "REGION_NOT_FOUND", "Region is not available.");
        const activeChildren = await deps.regions.listRegionChildren(region.id, { includeDeleted: false });

        if (activeChildren.length > 0) {
          throw new RegionHierarchyError("REGION_HAS_ACTIVE_CHILDREN", "Region must not have active child regions before soft delete.");
        }

        const deleted = await deps.regions.softDeleteRegion(region.id, {
          deleted_at: input.deleted_at,
          deleted_by_user_id: input.deleted_by_user_id,
          delete_reason: input.delete_reason,
        });

        await appendRegionAudit(deps, {
          actor_user_id: input.deleted_by_user_id ?? null,
          action: "region.soft_delete",
          entity_id: deleted.id,
          summary: "Soft deleted logical region.",
          before_payload: { deleted_at: region.deleted_at ?? null, is_active: region.is_active },
          after_payload: { deleted_at: deleted.deleted_at ?? null, is_active: deleted.is_active },
          metadata: { delete_reason: input.delete_reason ?? null },
        });

        return deleted;
      });
    },

    async restoreRegion(input) {
      return withTransaction(database, async (trx) => {
        const deps = createRegionServiceDependencies(trx);
        const regionId = normalizeString(input.region_id);

        if (!regionId) {
          throw new RegionHierarchyError("REGION_NOT_FOUND", "Region id is required.");
        }

        const existing = await deps.regions.getRegionById(regionId, { includeDeleted: true });

        if (!existing) {
          throw new RegionHierarchyError("REGION_NOT_FOUND", "Region is not available.");
        }

        if (!existing.deleted_at) {
          return existing;
        }

        if (existing.parent_id) {
          const parent = await deps.regions.getRegionById(existing.parent_id, { includeDeleted: true });

          if (!parent || parent.deleted_at) {
            throw new RegionHierarchyError("PARENT_REGION_NOT_FOUND", "Parent region must be restored before this region can be restored.");
          }
        }

        const restored = await deps.regions.restoreRegion(existing.id);

        await appendRegionAudit(deps, {
          action: "region.restore",
          entity_id: restored.id,
          summary: "Restored logical region.",
          before_payload: { deleted_at: existing.deleted_at ?? null, is_active: existing.is_active },
          after_payload: { deleted_at: restored.deleted_at ?? null, is_active: restored.is_active },
        });

        return restored;
      });
    },
  };
}

export { MAX_REGION_DEPTH };
