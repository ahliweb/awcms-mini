import test from "node:test";
import assert from "node:assert/strict";

import { createAuthorizedPluginRoute } from "../../src/plugins/route-authorization.mjs";

function createActor() {
  return {
    id: "admin_1",
    status: "active",
    isProtected: false,
    activeRoleStaffLevel: 7,
  };
}

function createSession(values = {}) {
  const store = new Map(Object.entries(values));
  return {
    async get(key) {
      return store.get(key);
    },
  };
}

test("plugin route authorization helper evaluates declared permission before handler", async () => {
  const authorizationCalls = [];
  const route = createAuthorizedPluginRoute({
    pluginId: "sample-plugin",
    permissions: [
      { code: "sample.widgets.read" },
    ],
    guard: {
      permissionCode: "sample.widgets.read",
      action: "read",
    },
    getDatabase: () => ({ name: "db" }),
    resolveActor: async () => createActor(),
    getAuthorizationService: () => ({
      async evaluate(input) {
        authorizationCalls.push(input);
        return { allowed: true };
      },
    }),
    handler: async ({ pluginDb, pluginActor }) => ({
      ok: true,
      dbName: pluginDb.name,
      actorId: pluginActor.id,
    }),
  });

  const result = await route.handler({
    request: new Request("http://example.test/plugin/widgets", {
    }),
    session: createSession({ identitySession: { id: "session_1" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.dbName, "db");
  assert.equal(result.actorId, "admin_1");
  assert.equal(authorizationCalls[0].context.permission_code, "sample.widgets.read");
  assert.equal(authorizationCalls[0].context.action, "read");
});

test("plugin route authorization helper supports scoped resource resolvers", async () => {
  const authorizationCalls = [];
  const route = createAuthorizedPluginRoute({
    pluginId: "sample-plugin",
    permissions: [
      { code: "sample.widgets.update" },
    ],
    guard: {
      permissionCode: "sample.widgets.update",
      action: "update",
      resource: async ({ ctx }) => ({
        kind: "widget",
        resource_id: new URL(ctx.request.url).searchParams.get("id"),
      }),
    },
    getDatabase: () => ({}),
    resolveActor: async () => createActor(),
    getAuthorizationService: () => ({
      async evaluate(input) {
        authorizationCalls.push(input);
        return { allowed: true };
      },
    }),
    handler: async () => ({ ok: true }),
  });

  await route.handler({
    request: new Request("http://example.test/plugin/widgets?id=widget_1"),
    session: createSession(),
  });

  assert.deepEqual(authorizationCalls[0].resource, {
    kind: "widget",
    resource_id: "widget_1",
  });
});

test("plugin route authorization helper rejects undeclared permissions", () => {
  assert.throws(() => createAuthorizedPluginRoute({
    pluginId: "sample-plugin",
    permissions: [{ code: "sample.widgets.read" }],
    guard: {
      permissionCode: "sample.widgets.delete",
      action: "delete",
    },
    getDatabase: () => ({}),
    resolveActor: async () => createActor(),
    getAuthorizationService: () => ({ evaluate: async () => ({ allowed: true }) }),
    handler: async () => ({ ok: true }),
  }), /undeclared permission/);
});
