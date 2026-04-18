import test from "node:test";
import assert from "node:assert/strict";

import { createPluginRegionAwarenessHelper } from "../../src/plugins/region-awareness.mjs";

test("plugin region awareness helper resolves logical and administrative scope for a user", async () => {
  const helper = createPluginRegionAwarenessHelper({
    createLogicalRegionAssignments: () => ({
      async listUserRegionAssignmentsByUserId() {
        return [{ region_id: "region_root" }];
      },
    }),
    createLogicalRegions: () => ({
      async listRegionSubtree() {
        return [{ id: "region_root" }, { id: "region_child" }];
      },
    }),
    createAdministrativeRegionAssignments: () => ({
      async listUserAdministrativeRegionAssignmentsByUserId() {
        return [{ administrative_region_id: "province_jb" }];
      },
    }),
    createAdministrativeRegions: () => ({
      async listAdministrativeRegionSubtree() {
        return [{ id: "province_jb" }, { id: "regency_bdg" }];
      },
    }),
  });

  assert.deepEqual(await helper.listUserLogicalRegionScopeIds({ userId: "user_1" }), ["region_child", "region_root"]);
  assert.deepEqual(await helper.listUserAdministrativeRegionScopeIds({ userId: "user_1" }), ["province_jb", "regency_bdg"]);
});

test("plugin region awareness helper builds scoped resource payloads", async () => {
  const helper = createPluginRegionAwarenessHelper({
    createLogicalRegionAssignments: () => ({
      async listUserRegionAssignmentsByUserId() {
        return [{ region_id: "region_root" }];
      },
    }),
    createLogicalRegions: () => ({
      async listRegionSubtree() {
        return [{ id: "region_root" }, { id: "region_child" }];
      },
    }),
    createAdministrativeRegionAssignments: () => ({
      async listUserAdministrativeRegionAssignmentsByUserId() {
        return [{ administrative_region_id: "province_jb" }];
      },
    }),
    createAdministrativeRegions: () => ({
      async listAdministrativeRegionSubtree() {
        return [{ id: "province_jb" }, { id: "regency_bdg" }];
      },
    }),
  });

  const logicalResource = await helper.buildScopedResource({
    resource: {
      kind: "region",
      target_user_id: "user_1",
    },
  });

  const administrativeResource = await helper.buildScopedResource({
    resource: {
      kind: "administrative_region",
      target_user_id: "user_1",
    },
  });

  assert.deepEqual(logicalResource.logical_region_ids, ["region_child", "region_root"]);
  assert.equal("administrative_region_ids" in logicalResource, false);
  assert.deepEqual(administrativeResource.administrative_region_ids, ["province_jb", "regency_bdg"]);
  assert.equal("logical_region_ids" in administrativeResource, false);
});
