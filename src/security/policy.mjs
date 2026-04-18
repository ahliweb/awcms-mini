const state = {
  mandatoryTwoFactorRolloutMode: "none",
  customMandatoryTwoFactorRoleIds: [],
};

function normalizeRoleIds(values) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    : [];
}

function normalizeRolloutMode(value) {
  return ["none", "protected_roles", "custom"].includes(value) ? value : "none";
}

export function resolveMandatoryTwoFactorRoleIds(policy = {}, roles = []) {
  const rolloutMode = normalizeRolloutMode(policy.mandatoryTwoFactorRolloutMode);

  if (rolloutMode === "protected_roles") {
    return normalizeRoleIds(roles.filter((role) => role?.isProtected === true).map((role) => role.id));
  }

  if (rolloutMode === "custom") {
    return normalizeRoleIds(policy.customMandatoryTwoFactorRoleIds);
  }

  return [];
}

export function getSecurityPolicy(options = {}) {
  const policy = {
    mandatoryTwoFactorRolloutMode: state.mandatoryTwoFactorRolloutMode,
    customMandatoryTwoFactorRoleIds: [...state.customMandatoryTwoFactorRoleIds],
  };

  return {
    ...policy,
    mandatoryTwoFactorRoleIds: resolveMandatoryTwoFactorRoleIds(policy, options.roles ?? []),
  };
}

export function updateSecurityPolicy(input = {}, options = {}) {
  const rolloutMode = normalizeRolloutMode(
    input.mandatoryTwoFactorRolloutMode ?? (Array.isArray(input.mandatoryTwoFactorRoleIds) && input.mandatoryTwoFactorRoleIds.length > 0 ? "custom" : "none"),
  );
  const roleIds = normalizeRoleIds(input.customMandatoryTwoFactorRoleIds ?? input.mandatoryTwoFactorRoleIds);

  state.mandatoryTwoFactorRolloutMode = rolloutMode;
  state.customMandatoryTwoFactorRoleIds = roleIds;
  return getSecurityPolicy(options);
}

export function resetSecurityPolicy() {
  state.mandatoryTwoFactorRolloutMode = "none";
  state.customMandatoryTwoFactorRoleIds = [];
}
