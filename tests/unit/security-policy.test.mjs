import test from "node:test";
import assert from "node:assert/strict";

import { getSecurityPolicy, resetSecurityPolicy, resolveMandatoryTwoFactorRoleIds, updateSecurityPolicy } from "../../src/security/policy.mjs";

test("security policy supports protected-role rollout and custom role selection", () => {
  const roles = [
    { id: "role_owner", isProtected: true },
    { id: "role_editor", isProtected: false },
  ];

  resetSecurityPolicy();

  const protectedFirst = updateSecurityPolicy({ mandatoryTwoFactorRolloutMode: "protected_roles" }, { roles });
  assert.equal(protectedFirst.mandatoryTwoFactorRolloutMode, "protected_roles");
  assert.deepEqual(protectedFirst.mandatoryTwoFactorRoleIds, ["role_owner"]);
  assert.deepEqual(protectedFirst.customMandatoryTwoFactorRoleIds, []);

  const custom = updateSecurityPolicy({ mandatoryTwoFactorRolloutMode: "custom", customMandatoryTwoFactorRoleIds: ["role_editor"] }, { roles });
  assert.equal(custom.mandatoryTwoFactorRolloutMode, "custom");
  assert.deepEqual(custom.mandatoryTwoFactorRoleIds, ["role_editor"]);
  assert.deepEqual(getSecurityPolicy({ roles }).customMandatoryTwoFactorRoleIds, ["role_editor"]);

  assert.deepEqual(resolveMandatoryTwoFactorRoleIds({ mandatoryTwoFactorRolloutMode: "protected_roles" }, roles), ["role_owner"]);
  resetSecurityPolicy();
});
