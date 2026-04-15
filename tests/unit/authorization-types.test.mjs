import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTHORIZATION_REASON_CODES,
  AUTHORIZATION_SESSION_STRENGTHS,
  createAuthorizationEvaluationInput,
  createAuthorizationReason,
  createAuthorizationResult,
} from "../../src/services/authorization/types.mjs";

test("authorization evaluation input represents roles, jobs, regions, ownership, and session strength", () => {
  const input = createAuthorizationEvaluationInput({
    subject: {
      kind: "user",
      user_id: "user_1",
      role_ids: ["role_editor", "role_admin", "role_editor"],
      permission_codes: ["content.posts.update", "admin.users.read"],
      staff_level: 8,
      job_level_rank: 5,
      logical_region_ids: ["region_west", "region_central"],
      administrative_region_ids: ["admin_region_1"],
      status: "active",
      is_protected: true,
      is_owner: false,
      two_factor_enabled: true,
    },
    resource: {
      kind: "content",
      resource_id: "post_1",
      owner_user_id: "user_1",
      target_user_id: "user_2",
      target_role_id: "role_editor",
      target_staff_level: 6,
      logical_region_ids: ["region_west"],
      administrative_region_ids: ["admin_region_1"],
      sensitivity: "internal",
      is_protected: false,
    },
    context: {
      permission_code: "content.posts.update",
      action: "update",
      session_strength: "step_up",
      step_up_authenticated: true,
      request_type: "admin_route",
      ip_address: "127.0.0.1",
      ip_reputation: "trusted",
      occurred_at: "2026-04-15T05:00:00.000Z",
    },
  });

  assert.deepEqual(input.subject.role_ids, ["role_admin", "role_editor"]);
  assert.equal(input.subject.job_level_rank, 5);
  assert.deepEqual(input.subject.logical_region_ids, ["region_central", "region_west"]);
  assert.equal(input.resource.owner_user_id, "user_1");
  assert.equal(input.resource.target_staff_level, 6);
  assert.equal(input.context.session_strength, "step_up");
  assert.equal(AUTHORIZATION_SESSION_STRENGTHS.includes(input.context.session_strength), true);
});

test("authorization reason structure is explicit and machine-readable", () => {
  const reason = createAuthorizationReason({
    code: "DENY_STEP_UP_REQUIRED",
    message: "Step-up authentication is required for this action.",
    details: {
      permission_code: "admin.roles.assign",
      required_session_strength: "step_up",
    },
  });

  assert.equal(AUTHORIZATION_REASON_CODES.includes(reason.code), true);
  assert.equal(reason.code, "DENY_STEP_UP_REQUIRED");
  assert.equal(reason.details.required_session_strength, "step_up");
});

test("authorization results preserve explicit allow or deny reasoning", () => {
  const denyResult = createAuthorizationResult({
    allowed: false,
    permission_code: "admin.permissions.update",
    matched_rule: "require-step-up-for-protected-permissions",
    reason: {
      code: "DENY_STEP_UP_REQUIRED",
      message: "Step-up authentication is required for this action.",
      details: {
        action: "update",
      },
    },
  });

  const allowResult = createAuthorizationResult({
    allowed: true,
    permission_code: "content.posts.read",
    matched_rule: "rbac-baseline",
    reason: {
      code: "ALLOW_RBAC_PERMISSION",
      message: "Permission is granted by the active role set.",
      details: {},
    },
  });

  assert.equal(denyResult.allowed, false);
  assert.equal(denyResult.reason.code, "DENY_STEP_UP_REQUIRED");
  assert.equal(allowResult.allowed, true);
  assert.equal(allowResult.reason.code, "ALLOW_RBAC_PERMISSION");
});
