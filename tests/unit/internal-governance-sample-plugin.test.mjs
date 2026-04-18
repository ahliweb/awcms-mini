import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlugin,
  internalGovernanceSamplePlugin,
  SAMPLE_PLUGIN_PERMISSIONS,
  resetSampleAuditServiceFactory,
  resetSampleAuthorizationServiceFactory,
  resetSampleDatabaseGetter,
  resetSampleRecordServiceFactory,
  resetSampleRegionAwarenessFactory,
  setSampleAuditServiceFactory,
  setSampleAuthorizationServiceFactory,
  setSampleDatabaseGetter,
  setSampleRecordServiceFactory,
  setSampleRegionAwarenessFactory,
} from "../../src/plugins/internal-governance-sample/index.mjs";

test("internal governance sample plugin exercises the governance contract end to end", async () => {
  const plugin = createPlugin();
  const routeAuthorizationCalls = [];
  const serviceAuthorizationCalls = [];
  const auditEntries = [];
  const records = [
    { id: "record_1", userId: "user_1", status: "open" },
  ];

  setSampleDatabaseGetter(() => ({ name: "sample-db" }));
  setSampleAuthorizationServiceFactory(() => ({
    async evaluate(input) {
      if (input.context.permission_code === "sample.records.read") {
        routeAuthorizationCalls.push(input);
      } else {
        serviceAuthorizationCalls.push(input);
      }

      return { allowed: true, reason: { code: "ALLOW_RBAC_PERMISSION" } };
    },
  }));
  setSampleRecordServiceFactory(() => ({
    async listRecordsByUserId(userId) {
      return records.filter((item) => item.userId === userId);
    },
    async flagRecord({ userId, recordId }) {
      return { id: recordId, userId, status: "flagged" };
    },
  }));
  setSampleAuditServiceFactory(() => ({
    async append(entry) {
      auditEntries.push(entry);
      return entry;
    },
  }));
  setSampleRegionAwarenessFactory(() => ({
    async buildScopedResource({ resource }) {
      return {
        ...resource,
        logical_region_ids: ["region_branch"],
        administrative_region_ids: ["regency_bdg"],
      };
    },
  }));

  try {
    assert.equal(plugin.id, "internal-governance-sample");
    assert.equal(SAMPLE_PLUGIN_PERMISSIONS.some((entry) => entry.code === "sample.records.flag"), true);

    const manifest = internalGovernanceSamplePlugin();
    assert.equal(manifest.permissions.length, SAMPLE_PLUGIN_PERMISSIONS.length);

    const listBody = await plugin.routes["records/list"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/internal-governance-sample/records/list?userId=user_1", {
        headers: { "x-actor-user-id": "admin_actor", "x-session-id": "session_1" },
      }),
    });

    assert.equal(listBody.items.length, 1);
    assert.equal(routeAuthorizationCalls[0].context.permission_code, "sample.records.read");
    assert.deepEqual(routeAuthorizationCalls[0].resource.logical_region_ids, ["region_branch"]);

    const flagBody = await plugin.routes["records/flag"].handler({
      request: new Request("http://example.test/_emdash/api/plugins/internal-governance-sample/records/flag", {
        method: "POST",
        headers: {
          "x-actor-user-id": "admin_actor",
          "x-session-id": "session_2",
          "x-request-id": "req_1",
          "x-forwarded-for": "127.0.0.1, 10.0.0.1",
          "user-agent": "unit-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "user_1", recordId: "record_1" }),
      }),
    });

    assert.equal(flagBody.item.status, "flagged");
    assert.equal(serviceAuthorizationCalls[0].context.permission_code, "sample.records.flag");
    assert.deepEqual(serviceAuthorizationCalls[0].resource.logical_region_ids, ["region_branch"]);
    assert.deepEqual(serviceAuthorizationCalls[0].resource.administrative_region_ids, ["regency_bdg"]);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].action, "plugin.sample.records.flag");
    assert.equal(auditEntries[0].metadata.plugin_id, "internal-governance-sample");
    assert.equal(auditEntries[0].request_id, "req_1");
  } finally {
    resetSampleDatabaseGetter();
    resetSampleAuthorizationServiceFactory();
    resetSampleRecordServiceFactory();
    resetSampleAuditServiceFactory();
    resetSampleRegionAwarenessFactory();
  }
});
