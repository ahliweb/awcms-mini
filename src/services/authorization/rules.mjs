import { createAuthorizationResult } from "./types.mjs";
import { createStandardAuthorizationReason } from "./reasons.mjs";

const SELF_USER_ACTIONS = new Set(["read", "update", "manage"]);
const SELF_SESSION_ACTIONS = new Set(["read", "revoke", "manage"]);
const OWN_CONTENT_ACTIONS = new Set(["read", "create", "update", "delete", "publish"]);

function createScopedAllowResult(permissionCode, matchedRule, scope) {
  return createAuthorizationResult({
    allowed: true,
    permission_code: permissionCode,
    matched_rule: matchedRule,
    reason: createStandardAuthorizationReason("ALLOW_ABAC_RULE", {
      permission_code: permissionCode,
      scope,
    }),
  });
}

function createExplicitDenyResult(permissionCode, matchedRule, details) {
  return createAuthorizationResult({
    allowed: false,
    permission_code: permissionCode,
    matched_rule: matchedRule,
    reason: createStandardAuthorizationReason("DENY_PROTECTED_TARGET", details),
  });
}

function createRegionScopeDenyResult(permissionCode, matchedRule, details) {
  return createAuthorizationResult({
    allowed: false,
    permission_code: permissionCode,
    matched_rule: matchedRule,
    reason: createStandardAuthorizationReason("DENY_REGION_SCOPE_MISMATCH", details),
  });
}

function evaluateStaffLevelDenyRule(evaluation) {
  if (!evaluation.resource.is_protected) {
    return null;
  }

  if (!new Set(["user", "role"]).has(evaluation.resource.kind)) {
    return null;
  }

  if (evaluation.context.override_target_protection === true) {
    return null;
  }

  if (evaluation.subject.staff_level > evaluation.resource.target_staff_level) {
    return null;
  }

  return createExplicitDenyResult(evaluation.context.permission_code, "staff-level:protected-target", {
    actor_staff_level: evaluation.subject.staff_level,
    target_staff_level: evaluation.resource.target_staff_level,
    resource_kind: evaluation.resource.kind,
    override_available: true,
  });
}

function evaluateLogicalRegionScopeDenyRule(evaluation) {
  const targetRegionIds = evaluation.resource.logical_region_ids ?? [];

  if (targetRegionIds.length === 0) {
    return null;
  }

  const actorRegionScopeIds = new Set(evaluation.subject.logical_region_ids ?? []);

  if (targetRegionIds.some((regionId) => actorRegionScopeIds.has(regionId))) {
    return null;
  }

  return createRegionScopeDenyResult(evaluation.context.permission_code, "logical-region:scope", {
    actor_logical_region_ids: [...actorRegionScopeIds].sort((left, right) => left.localeCompare(right)),
    target_logical_region_ids: [...targetRegionIds].sort((left, right) => left.localeCompare(right)),
    resource_kind: evaluation.resource.kind,
  });
}

function isSelfTarget(evaluation) {
  const subjectUserId = evaluation.subject.user_id;

  if (!subjectUserId) {
    return false;
  }

  return (
    evaluation.resource.target_user_id === subjectUserId ||
    evaluation.resource.owner_user_id === subjectUserId ||
    evaluation.resource.resource_id === subjectUserId
  );
}

function evaluateSelfServiceRule(evaluation) {
  if (!isSelfTarget(evaluation)) {
    return null;
  }

  if (evaluation.resource.kind === "user" && SELF_USER_ACTIONS.has(evaluation.context.action)) {
    return createScopedAllowResult(evaluation.context.permission_code, "self-service:user", "self");
  }

  if (evaluation.resource.kind === "session" && SELF_SESSION_ACTIONS.has(evaluation.context.action)) {
    return createScopedAllowResult(evaluation.context.permission_code, "self-service:session", "self");
  }

  return null;
}

function evaluateOwnershipRule(evaluation) {
  if (evaluation.resource.kind !== "content") {
    return null;
  }

  if (evaluation.resource.owner_user_id !== evaluation.subject.user_id) {
    return null;
  }

  if (!OWN_CONTENT_ACTIONS.has(evaluation.context.action)) {
    return null;
  }

  return createScopedAllowResult(evaluation.context.permission_code, "ownership:content", "ownership");
}

function evaluateScopedAllowRules(evaluation) {
  return evaluateSelfServiceRule(evaluation) ?? evaluateOwnershipRule(evaluation) ?? null;
}

export {
  evaluateLogicalRegionScopeDenyRule,
  evaluateOwnershipRule,
  evaluateScopedAllowRules,
  evaluateSelfServiceRule,
  evaluateStaffLevelDenyRule,
};
