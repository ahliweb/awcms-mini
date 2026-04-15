import { getDatabase } from "../../db/index.mjs";
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

export function createAuthorizationService(options = {}) {
  const database = options.database ?? getDatabase();
  const cache = options.cache ?? createNoopAuthorizationCache();
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

export { createPermissionAllowedResult, createPermissionMissingResult };
