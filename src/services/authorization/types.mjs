const AUTHORIZATION_ACTIONS = ["read", "create", "update", "delete", "assign", "revoke", "publish", "manage", "evaluate"];

const AUTHORIZATION_SUBJECT_KINDS = ["user", "service"];

const AUTHORIZATION_RESOURCE_KINDS = [
  "user",
  "role",
  "permission",
  "session",
  "content",
  "job",
  "region",
  "administrative_region",
  "system",
];

const AUTHORIZATION_SESSION_STRENGTHS = ["none", "password", "trusted_device", "two_factor", "step_up"];

const AUTHORIZATION_REASON_CODES = [
  "ALLOW_RBAC_PERMISSION",
  "ALLOW_ABAC_RULE",
  "DENY_UNAUTHENTICATED",
  "DENY_PERMISSION_MISSING",
  "DENY_PROTECTED_TARGET",
  "DENY_REGION_SCOPE_MISMATCH",
  "DENY_STEP_UP_REQUIRED",
  "DENY_EXPLICIT_RULE",
];

function assertAllowedValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new TypeError(`Invalid ${label}: ${value}`);
  }

  return value;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => String(value)))].sort((left, right) => left.localeCompare(right));
}

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return false;
  }

  return Boolean(value);
}

function normalizeNullableString(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value);
}

function normalizeAuthorizationSubject(input = {}) {
  return {
    kind: assertAllowedValue(input.kind ?? "user", AUTHORIZATION_SUBJECT_KINDS, "authorization subject kind"),
    user_id: normalizeNullableString(input.user_id),
    role_ids: normalizeStringArray(input.role_ids),
    permission_codes: normalizeStringArray(input.permission_codes),
    staff_level: Number(input.staff_level ?? 0),
    job_level_rank: Number(input.job_level_rank ?? 0),
    logical_region_ids: normalizeStringArray(input.logical_region_ids),
    administrative_region_ids: normalizeStringArray(input.administrative_region_ids),
    status: normalizeNullableString(input.status),
    is_protected: normalizeBoolean(input.is_protected),
    is_owner: normalizeBoolean(input.is_owner),
    two_factor_enabled: normalizeBoolean(input.two_factor_enabled),
  };
}

function normalizeAuthorizationResource(input = {}) {
  return {
    kind: assertAllowedValue(input.kind ?? "system", AUTHORIZATION_RESOURCE_KINDS, "authorization resource kind"),
    resource_id: normalizeNullableString(input.resource_id),
    owner_user_id: normalizeNullableString(input.owner_user_id),
    target_user_id: normalizeNullableString(input.target_user_id),
    target_role_id: normalizeNullableString(input.target_role_id),
    target_staff_level: Number(input.target_staff_level ?? 0),
    logical_region_ids: normalizeStringArray(input.logical_region_ids),
    administrative_region_ids: normalizeStringArray(input.administrative_region_ids),
    sensitivity: normalizeNullableString(input.sensitivity),
    is_protected: normalizeBoolean(input.is_protected),
  };
}

function normalizeAuthorizationContext(input = {}) {
  return {
    permission_code: normalizeNullableString(input.permission_code),
    action: assertAllowedValue(input.action ?? "evaluate", AUTHORIZATION_ACTIONS, "authorization action"),
    session_strength: assertAllowedValue(
      input.session_strength ?? "none",
      AUTHORIZATION_SESSION_STRENGTHS,
      "authorization session strength",
    ),
    step_up_authenticated: normalizeBoolean(input.step_up_authenticated),
    request_type: normalizeNullableString(input.request_type),
    ip_address: normalizeNullableString(input.ip_address),
    ip_reputation: normalizeNullableString(input.ip_reputation),
    occurred_at: normalizeNullableString(input.occurred_at),
    override_target_protection: normalizeBoolean(input.override_target_protection),
  };
}

function createAuthorizationEvaluationInput(input = {}) {
  return {
    subject: normalizeAuthorizationSubject(input.subject),
    resource: normalizeAuthorizationResource(input.resource),
    context: normalizeAuthorizationContext(input.context),
  };
}

function createAuthorizationReason(input = {}) {
  return {
    code: assertAllowedValue(input.code, AUTHORIZATION_REASON_CODES, "authorization reason code"),
    message: String(input.message ?? ""),
    effect: normalizeNullableString(input.effect),
    category: normalizeNullableString(input.category),
    security_relevant: normalizeBoolean(input.security_relevant),
    details: input.details && typeof input.details === "object" && !Array.isArray(input.details) ? input.details : {},
  };
}

function createAuthorizationResult(input = {}) {
  return {
    allowed: normalizeBoolean(input.allowed),
    reason: input.reason ? createAuthorizationReason(input.reason) : null,
    matched_rule: normalizeNullableString(input.matched_rule),
    permission_code: normalizeNullableString(input.permission_code),
  };
}

export {
  AUTHORIZATION_ACTIONS,
  AUTHORIZATION_REASON_CODES,
  AUTHORIZATION_RESOURCE_KINDS,
  AUTHORIZATION_SESSION_STRENGTHS,
  AUTHORIZATION_SUBJECT_KINDS,
  createAuthorizationEvaluationInput,
  createAuthorizationReason,
  createAuthorizationResult,
  normalizeAuthorizationContext,
  normalizeAuthorizationResource,
  normalizeAuthorizationSubject,
};
