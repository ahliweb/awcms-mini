import { getDatabase } from "../../db/index.mjs";
import { createPermissionResolutionService } from "../permissions/service.mjs";
import {
  createAuthorizationEvaluationInput,
  createAuthorizationResult,
} from "./types.mjs";

function createPermissionMissingResult(permissionCode) {
  return createAuthorizationResult({
    allowed: false,
    permission_code: permissionCode,
    matched_rule: "rbac-baseline",
    reason: {
      code: "DENY_PERMISSION_MISSING",
      message: "The active role set does not grant the required permission.",
      details: {
        permission_code: permissionCode,
      },
    },
  });
}

function createPermissionAllowedResult(permissionCode) {
  return createAuthorizationResult({
    allowed: true,
    permission_code: permissionCode,
    matched_rule: "rbac-baseline",
    reason: {
      code: "ALLOW_RBAC_PERMISSION",
      message: "The active role set grants the required permission.",
      details: {
        permission_code: permissionCode,
      },
    },
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
          reason: {
            code: "DENY_UNAUTHENTICATED",
            message: "Authorization requires an authenticated subject.",
            details: {
              permission_code: permissionCode,
            },
          },
        });
      }

      if (!permissionCode) {
        return createAuthorizationResult({
          allowed: false,
          permission_code: null,
          matched_rule: "authorization-entry",
          reason: {
            code: "DENY_EXPLICIT_RULE",
            message: "Authorization evaluation requires a permission code.",
            details: {},
          },
        });
      }

      const resolved = await permissionResolver.getEffectivePermissions(evaluation.subject.user_id);

      return resolved.permission_codes.includes(permissionCode)
        ? createPermissionAllowedResult(permissionCode)
        : createPermissionMissingResult(permissionCode);
    },

    async hasPermission(input = {}) {
      const result = await this.evaluate(input);
      return result.allowed;
    },
  };
}

export { createPermissionAllowedResult, createPermissionMissingResult };
