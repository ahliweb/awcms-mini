import test from "node:test";
import assert from "node:assert/strict";

import { collectRegisteredPluginPermissions, normalizePluginPermissionDeclaration } from "../../src/plugins/permission-registration.mjs";

test("plugin permission registration normalizes declarations into core catalog shape", () => {
  const entry = normalizePluginPermissionDeclaration("sample-plugin", {
    code: "sample.widgets.read",
    domain: "sample",
    resource: "widgets",
    action: "read",
    description: "Inspect sample widgets.",
  });

  assert.deepEqual(entry, {
    id: "plugin_perm_sample_plugin_sample_widgets_read",
    code: "sample.widgets.read",
    domain: "sample",
    resource: "widgets",
    action: "read",
    description: "Inspect sample widgets.",
    is_protected: false,
    created_at: null,
    plugin_id: "sample-plugin",
  });
});

test("plugin permission registration collects permissions across plugin manifests", () => {
  const permissions = collectRegisteredPluginPermissions([
    {
      id: "sample-plugin",
      permissions: [
        { code: "sample.widgets.read", domain: "sample", resource: "widgets", action: "read", description: "Inspect widgets." },
        { code: "sample.widgets.update", domain: "sample", resource: "widgets", action: "update", description: "Update widgets.", is_protected: true },
      ],
    },
  ]);

  assert.equal(permissions.length, 2);
  assert.deepEqual(permissions.map((entry) => entry.code), ["sample.widgets.read", "sample.widgets.update"]);
  assert.equal(permissions[1].is_protected, true);
});

test("plugin permission registration rejects duplicate permission codes", () => {
  assert.throws(() =>
    collectRegisteredPluginPermissions([
      { id: "sample-a", permissions: [{ code: "sample.widgets.read", domain: "sample", resource: "widgets", action: "read" }] },
      { id: "sample-b", permissions: [{ code: "sample.widgets.read", domain: "sample", resource: "widgets", action: "read" }] },
    ]),
  /Duplicate plugin permission code registered/);
});
