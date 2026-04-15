import test from "node:test";
import assert from "node:assert/strict";

import { createAuthorizationService } from "../../src/services/authorization/service.mjs";

test("authorization service denies unauthenticated subjects before permission resolution", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        throw new Error("should not resolve permissions");
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason.code, "DENY_UNAUTHENTICATED");
});

test("authorization service denies requests when the RBAC baseline lacks the permission", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions(userId) {
        assert.equal(userId, "user_1");
        return {
          user_id: userId,
          permission_codes: ["content.posts.read"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_1" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.matched_rule, "rbac-baseline");
  assert.equal(result.reason.code, "DENY_PERMISSION_MISSING");
  assert.equal(result.reason.details.permission_code, "admin.users.read");
});

test("authorization service allows requests when the RBAC baseline grants the permission", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions(userId) {
        assert.equal(userId, "user_2");
        return {
          user_id: userId,
          permission_codes: ["admin.users.read", "content.posts.read"],
        };
      },
    },
  });

  const allowed = await service.hasPermission({
    subject: { kind: "user", user_id: "user_2" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_2" },
    context: { permission_code: "admin.users.read", action: "read" },
  });

  assert.equal(allowed, true);
  assert.equal(result.allowed, true);
  assert.equal(result.reason.code, "ALLOW_RBAC_PERMISSION");
});

test("authorization service marks self-service user actions through a scoped allow rule", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_4",
          permission_codes: ["admin.users.update"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_4" },
    resource: { kind: "user", target_user_id: "user_4" },
    context: { permission_code: "admin.users.update", action: "update" },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.matched_rule, "self-service:user");
  assert.equal(result.reason.code, "ALLOW_ABAC_RULE");
});

test("authorization service marks self-session actions through a scoped allow rule", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_5",
          permission_codes: ["security.sessions.revoke"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_5" },
    resource: { kind: "session", owner_user_id: "user_5", resource_id: "session_1" },
    context: { permission_code: "security.sessions.revoke", action: "revoke" },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.matched_rule, "self-service:session");
});

test("authorization service marks owned content actions through an ownership rule without elevating beyond baseline", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions(userId) {
        return {
          user_id: userId,
          permission_codes: userId === "user_6" ? ["content.posts.update"] : [],
        };
      },
    },
  });

  const ownedResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_6" },
    resource: { kind: "content", owner_user_id: "user_6", resource_id: "post_1" },
    context: { permission_code: "content.posts.update", action: "update" },
  });

  const deniedResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_7" },
    resource: { kind: "content", owner_user_id: "user_7", resource_id: "post_2" },
    context: { permission_code: "content.posts.update", action: "update" },
  });

  assert.equal(ownedResult.allowed, true);
  assert.equal(ownedResult.matched_rule, "ownership:content");
  assert.equal(deniedResult.allowed, false);
  assert.equal(deniedResult.reason.code, "DENY_PERMISSION_MISSING");
});

test("authorization service denies peer or higher protected targets by default", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_admin",
          permission_codes: ["admin.users.update"],
        };
      },
    },
  });

  const peerResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_admin", staff_level: 8 },
    resource: { kind: "user", target_user_id: "user_target", target_staff_level: 8, is_protected: true },
    context: { permission_code: "admin.users.update", action: "update" },
  });

  const lowerResult = await service.evaluate({
    subject: { kind: "user", user_id: "user_admin", staff_level: 7 },
    resource: { kind: "role", target_role_id: "role_owner", target_staff_level: 10, is_protected: true },
    context: { permission_code: "admin.users.update", action: "update" },
  });

  assert.equal(peerResult.allowed, false);
  assert.equal(peerResult.reason.code, "DENY_PROTECTED_TARGET");
  assert.equal(lowerResult.allowed, false);
  assert.equal(lowerResult.matched_rule, "staff-level:protected-target");
});

test("authorization service allows override path for protected targets when explicit override is supplied", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        return {
          user_id: "user_super_admin",
          permission_codes: ["admin.roles.assign"],
        };
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_super_admin", staff_level: 9 },
    resource: { kind: "role", target_role_id: "role_owner", target_staff_level: 10, is_protected: true },
    context: {
      permission_code: "admin.roles.assign",
      action: "assign",
      override_target_protection: true,
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason.code, "ALLOW_RBAC_PERMISSION");
});

test("authorization service rejects evaluations without a permission code", async () => {
  const service = createAuthorizationService({
    permissionResolver: {
      async getEffectivePermissions() {
        throw new Error("should not resolve permissions");
      },
    },
  });

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_3" },
    context: { action: "read" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason.code, "DENY_EXPLICIT_RULE");
});
