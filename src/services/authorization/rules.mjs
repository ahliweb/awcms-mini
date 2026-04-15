import { createAuthorizationResult } from "./types.mjs";

const SELF_USER_ACTIONS = new Set(["read", "update", "manage"]);
const SELF_SESSION_ACTIONS = new Set(["read", "revoke", "manage"]);
const OWN_CONTENT_ACTIONS = new Set(["read", "create", "update", "delete", "publish"]);

function createScopedAllowResult(permissionCode, matchedRule, scope) {
  return createAuthorizationResult({
    allowed: true,
    permission_code: permissionCode,
    matched_rule: matchedRule,
    reason: {
      code: "ALLOW_ABAC_RULE",
      message: "The request is allowed by a scoped authorization rule.",
      details: {
        permission_code: permissionCode,
        scope,
      },
    },
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

export { evaluateOwnershipRule, evaluateScopedAllowRules, evaluateSelfServiceRule };
