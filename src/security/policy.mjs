const state = {
  mandatoryTwoFactorRoleIds: [],
};

export function getSecurityPolicy() {
  return {
    mandatoryTwoFactorRoleIds: [...state.mandatoryTwoFactorRoleIds],
  };
}

export function updateSecurityPolicy(input = {}) {
  const roleIds = Array.isArray(input.mandatoryTwoFactorRoleIds)
    ? [...new Set(input.mandatoryTwoFactorRoleIds.map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    : [];

  state.mandatoryTwoFactorRoleIds = roleIds;
  return getSecurityPolicy();
}

export function resetSecurityPolicy() {
  state.mandatoryTwoFactorRoleIds = [];
}
