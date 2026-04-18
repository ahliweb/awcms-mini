import { createAuthorizationReason } from "./types.mjs";

const AUTHORIZATION_REASON_DEFINITIONS = {
  ALLOW_RBAC_PERMISSION: {
    message: "The active role set grants the required permission.",
    effect: "allow",
    category: "rbac",
    security_relevant: false,
  },
  ALLOW_ABAC_RULE: {
    message: "The request is allowed by a scoped authorization rule.",
    effect: "allow",
    category: "abac",
    security_relevant: false,
  },
  ALLOW_ABAC_AUDIT_ONLY: {
    message: "The request matched an audit-only rollout path and was allowed without enforcement.",
    effect: "allow",
    category: "abac",
    security_relevant: true,
  },
  DENY_UNAUTHENTICATED: {
    message: "Authorization requires an authenticated subject.",
    effect: "deny",
    category: "entry",
    security_relevant: true,
  },
  DENY_PERMISSION_MISSING: {
    message: "The active role set does not grant the required permission.",
    effect: "deny",
    category: "rbac",
    security_relevant: false,
  },
  DENY_PROTECTED_TARGET: {
    message: "The target is protected by staff-level authorization rules.",
    effect: "deny",
    category: "abac",
    security_relevant: true,
  },
  DENY_REGION_SCOPE_MISMATCH: {
    message: "The request is outside the actor's authorized region scope.",
    effect: "deny",
    category: "abac",
    security_relevant: true,
  },
  DENY_STEP_UP_REQUIRED: {
    message: "Step-up authentication is required for this action.",
    effect: "deny",
    category: "security",
    security_relevant: true,
  },
  DENY_EXPLICIT_RULE: {
    message: "Authorization evaluation failed an explicit policy precondition.",
    effect: "deny",
    category: "entry",
    security_relevant: true,
  },
};

function createStandardAuthorizationReason(code, details = {}, overrides = {}) {
  const definition = AUTHORIZATION_REASON_DEFINITIONS[code];

  if (!definition) {
    throw new TypeError(`Unknown authorization reason definition: ${code}`);
  }

  return createAuthorizationReason({
    code,
    message: overrides.message ?? definition.message,
    effect: definition.effect,
    category: definition.category,
    security_relevant: definition.security_relevant,
    details,
  });
}

export { AUTHORIZATION_REASON_DEFINITIONS, createStandardAuthorizationReason };
