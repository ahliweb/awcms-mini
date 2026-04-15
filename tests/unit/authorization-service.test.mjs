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
