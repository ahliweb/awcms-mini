import { createAdministrativeRegionRepository } from "../db/repositories/administrative-regions.mjs";
import { createRegionRepository } from "../db/repositories/regions.mjs";
import { createUserAdministrativeRegionAssignmentRepository } from "../db/repositories/user-administrative-region-assignments.mjs";
import { createUserRegionAssignmentRepository } from "../db/repositories/user-region-assignments.mjs";

async function listLogicalRegionScopeIds(regionAssignments, regions, userId) {
  if (!userId) {
    return [];
  }

  const assignments = await regionAssignments.listUserRegionAssignmentsByUserId(userId, { activeOnly: true });
  const scopeIds = new Set();

  for (const assignment of assignments) {
    const subtree = await regions.listRegionSubtree(assignment.region_id, { includeDeleted: false, is_active: true });

    if (subtree.length === 0) {
      scopeIds.add(assignment.region_id);
      continue;
    }

    for (const region of subtree) {
      scopeIds.add(region.id);
    }
  }

  return [...scopeIds].sort((left, right) => left.localeCompare(right));
}

async function listAdministrativeRegionScopeIds(assignmentsRepo, regionsRepo, userId) {
  if (!userId) {
    return [];
  }

  const assignments = await assignmentsRepo.listUserAdministrativeRegionAssignmentsByUserId(userId, { activeOnly: true });
  const scopeIds = new Set();

  for (const assignment of assignments) {
    const subtree = await regionsRepo.listAdministrativeRegionSubtree(assignment.administrative_region_id, { is_active: true });

    if (subtree.length === 0) {
      scopeIds.add(assignment.administrative_region_id);
      continue;
    }

    for (const region of subtree) {
      scopeIds.add(region.id);
    }
  }

  return [...scopeIds].sort((left, right) => left.localeCompare(right));
}

export function createPluginRegionAwarenessHelper(options = {}) {
  const createLogicalRegionAssignments = options.createLogicalRegionAssignments ?? ((database) => createUserRegionAssignmentRepository(database));
  const createLogicalRegions = options.createLogicalRegions ?? ((database) => createRegionRepository(database));
  const createAdministrativeRegionAssignments = options.createAdministrativeRegionAssignments ?? ((database) => createUserAdministrativeRegionAssignmentRepository(database));
  const createAdministrativeRegions = options.createAdministrativeRegions ?? ((database) => createAdministrativeRegionRepository(database));

  return {
    async listUserLogicalRegionScopeIds(input) {
      const regionAssignments = createLogicalRegionAssignments(input?.database);
      const regions = createLogicalRegions(input?.database);
      return listLogicalRegionScopeIds(regionAssignments, regions, input?.userId);
    },

    async listUserAdministrativeRegionScopeIds(input) {
      const assignmentsRepo = createAdministrativeRegionAssignments(input?.database);
      const regionsRepo = createAdministrativeRegions(input?.database);
      return listAdministrativeRegionScopeIds(assignmentsRepo, regionsRepo, input?.userId);
    },

    async buildScopedResource(input) {
      const resource = {
        ...(input?.resource ?? {}),
      };

      const includeLogical = input?.includeLogical === true || resource.kind === "region";
      const includeAdministrative = input?.includeAdministrative === true || resource.kind === "administrative_region";

      if (
        includeLogical &&
        resource.target_user_id &&
        (!Array.isArray(resource.logical_region_ids) || resource.logical_region_ids.length === 0)
      ) {
        resource.logical_region_ids = await this.listUserLogicalRegionScopeIds({
          database: input?.database,
          userId: resource.target_user_id,
        });
      }

      if (
        includeAdministrative &&
        resource.target_user_id &&
        (!Array.isArray(resource.administrative_region_ids) || resource.administrative_region_ids.length === 0)
      ) {
        resource.administrative_region_ids = await this.listUserAdministrativeRegionScopeIds({
          database: input?.database,
          userId: resource.target_user_id,
        });
      }

      return resource;
    },
  };
}
