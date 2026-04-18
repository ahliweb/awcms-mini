import test from "node:test";
import assert from "node:assert/strict";

import { createPluginAuditHelper } from "../../src/plugins/audit-helper.mjs";

test("plugin audit helper appends normalized plugin metadata and request context", async () => {
  const entries = [];
  const previousTrustedProxyMode = process.env.TRUSTED_PROXY_MODE;
  process.env.TRUSTED_PROXY_MODE = "forwarded-chain";
  const helper = createPluginAuditHelper({
    pluginId: "sample-plugin",
    getAuditService: () => ({
      async append(input) {
        entries.push(input);
        return input;
      },
    }),
  });

  try {
    await helper.append({
      actorUserId: "admin_1",
      request: new Request("http://example.test/plugin/action", {
        headers: {
          "x-request-id": "req_1",
          "x-forwarded-for": "127.0.0.1, 10.0.0.1",
          "user-agent": "unit-test",
        },
      }),
      action: "plugin.sample.widgets.update",
      entityType: "widget",
      entityId: "widget_1",
      summary: "Updated sample widget.",
      metadata: {
        sample: true,
      },
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].request_id, "req_1");
    assert.equal(entries[0].ip_address, "127.0.0.1");
    assert.equal(entries[0].user_agent, "unit-test");
    assert.deepEqual(entries[0].metadata, {
      plugin_id: "sample-plugin",
      sample: true,
    });
  } finally {
    if (previousTrustedProxyMode === undefined) {
      delete process.env.TRUSTED_PROXY_MODE;
    } else {
      process.env.TRUSTED_PROXY_MODE = previousTrustedProxyMode;
    }
  }
});
