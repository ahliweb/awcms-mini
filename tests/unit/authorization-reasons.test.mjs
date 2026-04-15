import test from "node:test";
import assert from "node:assert/strict";

import { AUTHORIZATION_REASON_DEFINITIONS, createStandardAuthorizationReason } from "../../src/services/authorization/reasons.mjs";

test("standard authorization reasons produce stable machine-readable metadata", () => {
  const reason = createStandardAuthorizationReason("DENY_PROTECTED_TARGET", {
    actor_staff_level: 8,
    target_staff_level: 8,
  });

  assert.equal(reason.code, "DENY_PROTECTED_TARGET");
  assert.equal(reason.message, AUTHORIZATION_REASON_DEFINITIONS.DENY_PROTECTED_TARGET.message);
  assert.equal(reason.effect, "deny");
  assert.equal(reason.category, "abac");
  assert.equal(reason.security_relevant, true);
  assert.equal(reason.details.actor_staff_level, 8);
});

test("standard authorization reasons support explicit message overrides without losing metadata", () => {
  const reason = createStandardAuthorizationReason(
    "DENY_EXPLICIT_RULE",
    { missing_input: "permission_code" },
    { message: "Authorization evaluation requires a permission code." },
  );

  assert.equal(reason.code, "DENY_EXPLICIT_RULE");
  assert.equal(reason.message, "Authorization evaluation requires a permission code.");
  assert.equal(reason.effect, "deny");
  assert.equal(reason.category, "entry");
  assert.equal(reason.security_relevant, true);
});
