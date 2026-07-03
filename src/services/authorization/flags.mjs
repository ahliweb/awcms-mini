const DEFAULT_AUTHORIZATION_FEATURE_FLAGS = {
  abac_audit_only: false,
  abac_region_scope_audit_only: false,
  abac_protected_target_audit_only: false,
};

function normalizeBoolean(value) {
  return value === true;
}

function parseEnvBoolean(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/**
 * Sumber flag ABAC yang dikontrol operator (env), default semua `false` = ENFORCE.
 * Set ke `true` hanya untuk rollout audit-only sementara (deny dicatat, tidak
 * memblokir) — mis. saat memantau dampak sebelum enforce penuh (#313).
 *
 *   MINI_ABAC_AUDIT_ONLY                  → downgrade semua deny ABAC sensitif
 *   MINI_ABAC_REGION_SCOPE_AUDIT_ONLY     → hanya DENY_REGION_SCOPE_MISMATCH
 *   MINI_ABAC_PROTECTED_TARGET_AUDIT_ONLY → hanya DENY_PROTECTED_TARGET
 */
function readAuthorizationFeatureFlagsFromEnv(env = process.env) {
  return normalizeAuthorizationFeatureFlags({
    abac_audit_only: parseEnvBoolean(env?.MINI_ABAC_AUDIT_ONLY),
    abac_region_scope_audit_only: parseEnvBoolean(env?.MINI_ABAC_REGION_SCOPE_AUDIT_ONLY),
    abac_protected_target_audit_only: parseEnvBoolean(env?.MINI_ABAC_PROTECTED_TARGET_AUDIT_ONLY),
  });
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
  readAuthorizationFeatureFlagsFromEnv,
  shouldUseAuditOnlyMode,
};
