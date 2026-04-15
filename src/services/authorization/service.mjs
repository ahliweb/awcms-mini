import { getDatabase } from "../../db/index.mjs";
import { createPermissionResolutionService } from "../permissions/service.mjs";
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
  const permissionResolver =
    options.permissionResolver ??
    createPermissionResolutionService({
      database,
      hooks: options.permissionCacheHooks,
    });

  return {
    async evaluate(input = {}) {
      const evaluation = createAuthorizationEvaluationInput(input);
      const permissionCode = evaluation.context.permission_code;

      if (!evaluation.subject.user_id) {
        return createAuthorizationResult({
          allowed: false,
          permission_code: permissionCode,
          matched_rule: "authorization-entry",
          reason: createStandardAuthorizationReason("DENY_UNAUTHENTICATED", {
            permission_code: permissionCode,
          }),
        });
      }

      if (!permissionCode) {
        return createAuthorizationResult({
          allowed: false,
          permission_code: null,
          matched_rule: "authorization-entry",
          reason: createStandardAuthorizationReason(
            "DENY_EXPLICIT_RULE",
            {},
            { message: "Authorization evaluation requires a permission code." },
          ),
        });
      }

      const resolved = await permissionResolver.getEffectivePermissions(evaluation.subject.user_id);

      if (!resolved.permission_codes.includes(permissionCode)) {
        return createPermissionMissingResult(permissionCode);
      }

      const explicitDeny = evaluateStaffLevelDenyRule(evaluation);

      if (explicitDeny) {
        return explicitDeny;
      }

      return evaluateScopedAllowRules(evaluation) ?? createPermissionAllowedResult(permissionCode);
    },

    async hasPermission(input = {}) {
      const result = await this.evaluate(input);
      return result.allowed;
    },
  };
}

export { createPermissionAllowedResult, createPermissionMissingResult };
