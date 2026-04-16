import { getDatabase } from "../../db/index.mjs";
import { createJobLevelRepository } from "../../db/repositories/job-levels.mjs";
import { createJobTitleRepository } from "../../db/repositories/job-titles.mjs";
import { createAdministrativeRegionRepository } from "../../db/repositories/administrative-regions.mjs";
import { createRegionRepository } from "../../db/repositories/regions.mjs";
import { createUserJobRepository } from "../../db/repositories/user-jobs.mjs";
import { createUserAdministrativeRegionAssignmentRepository } from "../../db/repositories/user-administrative-region-assignments.mjs";
import { createUserRegionAssignmentRepository } from "../../db/repositories/user-region-assignments.mjs";
import { createPermissionResolutionService } from "../permissions/service.mjs";
import {
  createAuthorizationCacheEntry,
  createAuthorizationCacheKey,
  createNoopAuthorizationCache,
  isAuthorizationCacheEntryFresh,
} from "./cache.mjs";
import { createAuthorizationEvaluationInput, createAuthorizationResult } from "./types.mjs";
import { createStandardAuthorizationReason } from "./reasons.mjs";
import {
  evaluateAdministrativeRegionScopeDenyRule,
  evaluateLogicalRegionScopeDenyRule,
  evaluateScopedAllowRules,
  evaluateStaffLevelDenyRule,
} from "./rules.mjs";

function createPermissionMissingResult(permissionCode) {
  return createAuthorizationResult({
    allowed: false,
    permission_code: permissionCode,
    matched_rule: "rbac-baseline",
    reason: createStandardAuthorizationReason("DENY_PERMISSION_MISSING", {
      permission_code: permissionCode,
    }),
  });
}

function createPermissionAllowedResult(permissionCode) {
  return createAuthorizationResult({
    allowed: true,
    permission_code: permissionCode,
    matched_rule: "rbac-baseline",
    reason: createStandardAuthorizationReason("ALLOW_RBAC_PERMISSION", {
      permission_code: permissionCode,
    }),
  });
}

function createAuthorizationJobContextResolver(database) {
  const jobLevels = createJobLevelRepository(database);
  const jobTitles = createJobTitleRepository(database);
  const userJobs = createUserJobRepository(database);

  return async function resolveCurrentJobContext(subject) {
    if (!subject?.user_id) {
      return subject;
    }

    if (subject.current_job_id || subject.current_job_level_id || subject.current_job_title_id || subject.supervisor_user_id) {
      return subject;
    }

    const activeJobs = await userJobs.listUserJobsByUserId(subject.user_id, { activeOnly: true });
    const currentJob = activeJobs.find((job) => job.is_primary) ?? activeJobs[0] ?? null;

    if (!currentJob) {
      return subject;
    }

    const jobLevel = await jobLevels.getJobLevelById(currentJob.job_level_id, { includeDeleted: false });
    const jobTitle = currentJob.job_title_id
      ? await jobTitles.getJobTitleById(currentJob.job_title_id, { includeDeleted: false })
      : null;

    return {
      ...subject,
      current_job_id: currentJob.id,
      current_job_level_id: currentJob.job_level_id,
      current_job_title_id: currentJob.job_title_id ?? null,
      supervisor_user_id: currentJob.supervisor_user_id ?? null,
      job_level_rank: subject.job_level_rank > 0 ? subject.job_level_rank : Number(jobLevel?.rank_order ?? 0),
      current_job_level_code: jobLevel?.code ?? null,
      current_job_title_code: jobTitle?.code ?? null,
    };
  };
}

async function listUserLogicalRegionScopeIds(regionAssignments, regions, userId) {
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

function createAuthorizationLogicalRegionContextResolver(database) {
  const regions = createRegionRepository(database);
  const regionAssignments = createUserRegionAssignmentRepository(database);

  return async function resolveLogicalRegionContext(evaluation) {
    const nextSubjectLogicalRegionIds =
      evaluation.subject.logical_region_ids.length > 0
        ? evaluation.subject.logical_region_ids
        : await listUserLogicalRegionScopeIds(regionAssignments, regions, evaluation.subject.user_id);

    let nextResourceLogicalRegionIds = evaluation.resource.logical_region_ids;

    if (nextResourceLogicalRegionIds.length === 0 && evaluation.resource.target_user_id) {
      nextResourceLogicalRegionIds = await listUserLogicalRegionScopeIds(
        regionAssignments,
        regions,
        evaluation.resource.target_user_id,
      );
    }

    if (nextResourceLogicalRegionIds.length === 0 && evaluation.resource.kind === "region" && evaluation.resource.resource_id) {
      nextResourceLogicalRegionIds = [evaluation.resource.resource_id];
    }

    return {
      ...evaluation,
      subject: {
        ...evaluation.subject,
        logical_region_ids: nextSubjectLogicalRegionIds,
      },
      resource: {
        ...evaluation.resource,
        logical_region_ids: nextResourceLogicalRegionIds,
      },
    };
  };
}

async function listUserAdministrativeRegionScopeIds(administrativeRegionAssignments, administrativeRegions, userId) {
  if (!userId) {
    return [];
  }

  const assignments = await administrativeRegionAssignments.listUserAdministrativeRegionAssignmentsByUserId(userId, { activeOnly: true });
  const scopeIds = new Set();

  for (const assignment of assignments) {
    const subtree = await administrativeRegions.listAdministrativeRegionSubtree(assignment.administrative_region_id, { is_active: true });

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

function createAuthorizationAdministrativeRegionContextResolver(database) {
  const administrativeRegions = createAdministrativeRegionRepository(database);
  const administrativeRegionAssignments = createUserAdministrativeRegionAssignmentRepository(database);

  return async function resolveAdministrativeRegionContext(evaluation) {
    const nextSubjectAdministrativeRegionIds =
      evaluation.subject.administrative_region_ids.length > 0
        ? evaluation.subject.administrative_region_ids
        : await listUserAdministrativeRegionScopeIds(
            administrativeRegionAssignments,
            administrativeRegions,
            evaluation.subject.user_id,
          );

    let nextResourceAdministrativeRegionIds = evaluation.resource.administrative_region_ids;

    if (nextResourceAdministrativeRegionIds.length === 0 && evaluation.resource.target_user_id) {
      nextResourceAdministrativeRegionIds = await listUserAdministrativeRegionScopeIds(
        administrativeRegionAssignments,
        administrativeRegions,
        evaluation.resource.target_user_id,
      );
    }

    if (
      nextResourceAdministrativeRegionIds.length === 0 &&
      evaluation.resource.kind === "administrative_region" &&
      evaluation.resource.resource_id
    ) {
      nextResourceAdministrativeRegionIds = [evaluation.resource.resource_id];
    }

    return {
      ...evaluation,
      subject: {
        ...evaluation.subject,
        administrative_region_ids: nextSubjectAdministrativeRegionIds,
      },
      resource: {
        ...evaluation.resource,
        administrative_region_ids: nextResourceAdministrativeRegionIds,
      },
    };
  };
}

export function createAuthorizationService(options = {}) {
  const database = options.database ?? getDatabase();
  const cache = options.cache ?? createNoopAuthorizationCache();
  const resolveCurrentJobContext =
    options.jobContextResolver ?? (options.database ? createAuthorizationJobContextResolver(database) : async (subject) => subject);
  const resolveLogicalRegionContext =
    options.logicalRegionContextResolver ??
    (options.database ? createAuthorizationLogicalRegionContextResolver(database) : async (evaluation) => evaluation);
  const resolveAdministrativeRegionContext =
    options.administrativeRegionContextResolver ??
    (options.database ? createAuthorizationAdministrativeRegionContextResolver(database) : async (evaluation) => evaluation);
  const permissionResolver =
    options.permissionResolver ??
    createPermissionResolutionService({
      database,
      hooks: options.permissionCacheHooks,
      cache,
    });

  return {
    async evaluate(input = {}) {
      let evaluation = createAuthorizationEvaluationInput(input);
      evaluation.subject = await resolveCurrentJobContext(evaluation.subject);
      evaluation = await resolveLogicalRegionContext(evaluation);
      evaluation = await resolveAdministrativeRegionContext(evaluation);
      const permissionCode = evaluation.context.permission_code;
      const cacheKey = createAuthorizationCacheKey({
        scope: "evaluation",
        user_id: evaluation.subject.user_id,
        session_id: evaluation.context.session_id,
        permission_code: permissionCode,
      });

      const cacheEntry = await cache.get(cacheKey);

      if (isAuthorizationCacheEntryFresh(cacheEntry)) {
        return cacheEntry.value;
      }

      let result;

      if (!evaluation.subject.user_id) {
        result = createAuthorizationResult({
          allowed: false,
          permission_code: permissionCode,
          matched_rule: "authorization-entry",
          reason: createStandardAuthorizationReason("DENY_UNAUTHENTICATED", {
            permission_code: permissionCode,
          }),
        });
        await cache.set(cacheKey, createAuthorizationCacheEntry(result));
        return result;
      }

      if (!permissionCode) {
        result = createAuthorizationResult({
          allowed: false,
          permission_code: null,
          matched_rule: "authorization-entry",
          reason: createStandardAuthorizationReason(
            "DENY_EXPLICIT_RULE",
            {},
            { message: "Authorization evaluation requires a permission code." },
          ),
        });
        await cache.set(cacheKey, createAuthorizationCacheEntry(result));
        return result;
      }

      const resolved = await permissionResolver.getEffectivePermissions(evaluation.subject.user_id);

      if (!resolved.permission_codes.includes(permissionCode)) {
        result = createPermissionMissingResult(permissionCode);
        await cache.set(cacheKey, createAuthorizationCacheEntry(result));
        return result;
      }

      const explicitDeny = evaluateStaffLevelDenyRule(evaluation);

      if (explicitDeny) {
        await cache.set(cacheKey, createAuthorizationCacheEntry(explicitDeny));
        return explicitDeny;
      }

      const regionScopeDeny = evaluateLogicalRegionScopeDenyRule(evaluation);

      if (regionScopeDeny) {
        await cache.set(cacheKey, createAuthorizationCacheEntry(regionScopeDeny));
        return regionScopeDeny;
      }

      const administrativeRegionScopeDeny = evaluateAdministrativeRegionScopeDenyRule(evaluation);

      if (administrativeRegionScopeDeny) {
        await cache.set(cacheKey, createAuthorizationCacheEntry(administrativeRegionScopeDeny));
        return administrativeRegionScopeDeny;
      }

      result = evaluateScopedAllowRules(evaluation) ?? createPermissionAllowedResult(permissionCode);
      await cache.set(cacheKey, createAuthorizationCacheEntry(result));
      return result;
    },

    async hasPermission(input = {}) {
      const result = await this.evaluate(input);
      return result.allowed;
    },
  };
}

export {
  createAuthorizationJobContextResolver,
  createAuthorizationAdministrativeRegionContextResolver,
  createAuthorizationLogicalRegionContextResolver,
  createPermissionAllowedResult,
  createPermissionMissingResult,
};
