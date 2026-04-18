const DEFAULT_AUTHORIZATION_FEATURE_FLAGS = {
  abac_audit_only: false,
  abac_region_scope_audit_only: false,
  abac_protected_target_audit_only: false,
};

function normalizeBoolean(value) {
  return value === true;
}

function normalizeAuthorizationFeatureFlags(input = {}) {
  return {
    abac_audit_only: normalizeBoolean(input.abac_audit_only),
    abac_region_scope_audit_only: normalizeBoolean(input.abac_region_scope_audit_only),
    abac_protected_target_audit_only: normalizeBoolean(input.abac_protected_target_audit_only),
  };
}

function shouldUseAuditOnlyMode(flags, result) {
  if (!result?.reason?.code) {
    return false;
  }

  if (flags.abac_audit_only === true) {
    return result.reason.code === "DENY_REGION_SCOPE_MISMATCH" || result.reason.code === "DENY_PROTECTED_TARGET";
  }

  if (result.reason.code === "DENY_REGION_SCOPE_MISMATCH") {
    return flags.abac_region_scope_audit_only === true;
  }

  if (result.reason.code === "DENY_PROTECTED_TARGET") {
    return flags.abac_protected_target_audit_only === true;
  }

  return false;
}

export {
  DEFAULT_AUTHORIZATION_FEATURE_FLAGS,
  normalizeAuthorizationFeatureFlags,
  shouldUseAuditOnlyMode,
};
