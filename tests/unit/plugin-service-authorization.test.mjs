import test from "node:test";
import assert from "node:assert/strict";

import { createPluginServiceAuthorizationHelper } from "../../src/plugins/service-authorization.mjs";

function createActor() {
  return {
    id: "admin_1",
    status: "active",
    isProtected: false,
    activeRoleStaffLevel: 9,
  };
}

test("plugin service authorization helper evaluates declared permissions through the shared authorization service", async () => {
  const calls = [];
  const helper = createPluginServiceAuthorizationHelper({
    pluginId: "sample-plugin",
    permissions: [
      { code: "sample.widgets.update" },
    ],
    getAuthorizationService: () => ({
      async evaluate(input) {
        calls.push(input);
        return { allowed: true, matched_rule: "rbac-baseline" };
      },
    }),
  });

  const result = await helper.authorize({
    actor: createActor(),
    permissionCode: "sample.widgets.update",
    action: "update",
    resource: {
      kind: "widget",
      resource_id: "widget_1",
      target_user_id: "user_1",
    },
    sessionId: "session_1",
  });

  assert.equal(result.allowed, true);
  assert.equal(calls[0].subject.user_id, "admin_1");
  assert.equal(calls[0].context.permission_code, "sample.widgets.update");
  assert.equal(calls[0].resource.resource_id, "widget_1");
});

test("plugin service authorization helper rejects undeclared permissions", async () => {
  const helper = createPluginServiceAuthorizationHelper({
    pluginId: "sample-plugin",
    permissions: [
      { code: "sample.widgets.read" },
    ],
    getAuthorizationService: () => ({
      async evaluate() {
        return { allowed: true };
      },
    }),
  });

  await assert.rejects(
    () => helper.authorize({
      actor: createActor(),
      permissionCode: "sample.widgets.delete",
      action: "delete",
      resource: { kind: "widget", resource_id: "widget_1" },
    }),
    /undeclared permission/,
  );
});

test("plugin service authorization helper requires actor context", async () => {
  const helper = createPluginServiceAuthorizationHelper({
    pluginId: "sample-plugin",
    permissions: [
      { code: "sample.widgets.read" },
    ],
    getAuthorizationService: () => ({
      async evaluate() {
        return { allowed: true };
      },
    }),
  });

  await assert.rejects(
    () => helper.authorize({
      permissionCode: "sample.widgets.read",
      action: "read",
      resource: { kind: "widget" },
    }),
    /requires actor context/,
  );
});
