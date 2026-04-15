import { getDatabase } from "../../db/index.mjs";
import { createJobLevelRepository } from "../../db/repositories/job-levels.mjs";
import { createJobTitleRepository } from "../../db/repositories/job-titles.mjs";
import { createUserJobRepository } from "../../db/repositories/user-jobs.mjs";
import { createPermissionResolutionService } from "../permissions/service.mjs";
import {
  createAuthorizationCacheEntry,
  createAuthorizationCacheKey,
  createNoopAuthorizationCache,
  isAuthorizationCacheEntryFresh,
} from "./cache.mjs";
import { createAuthorizationEvaluationInput, createAuthorizationResult } from "./types.mjs";
import { createStandardAuthorizationReason } from "./reasons.mjs";
import { evaluateScopedAllowRules, evaluateStaffLevelDenyRule } from "./rules.mjs";

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

export function createAuthorizationService(options = {}) {
  const database = options.database ?? getDatabase();
  const cache = options.cache ?? createNoopAuthorizationCache();
  const resolveCurrentJobContext =
    options.jobContextResolver ?? (options.database ? createAuthorizationJobContextResolver(database) : async (subject) => subject);
  const permissionResolver =
    options.permissionResolver ??
    createPermissionResolutionService({
      database,
      hooks: options.permissionCacheHooks,
      cache,
    });

  return {
    async evaluate(input = {}) {
      const evaluation = createAuthorizationEvaluationInput(input);
      evaluation.subject = await resolveCurrentJobContext(evaluation.subject);
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

export { createAuthorizationJobContextResolver, createPermissionAllowedResult, createPermissionMissingResult };
