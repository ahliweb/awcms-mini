import test from "node:test";
import assert from "node:assert/strict";

import { loadAllPlugins } from "../../src/plugins/loader.mjs";
import { listPlugins, clearRegistry, getPlugin } from "../../src/plugins/registry.mjs";

test.afterEach(() => {
  clearRegistry();
});

test("plugin loader: loadAllPlugins dengan daftar plugin kosong tidak error", async () => {
  // plugins diinject kosong — independen dari ACTIVE_PLUGINS nyata
  await assert.doesNotReject(
    loadAllPlugins({ db: null, plugins: [] }),
    "loadAllPlugins dengan plugins kosong harus selesai tanpa error",
  );
});

test("plugin loader: loadAllPlugins dengan plugins kosong tidak mendaftarkan plugin", async () => {
  await loadAllPlugins({ db: null, plugins: [] });
  assert.deepEqual(listPlugins(), [], "Harus tidak ada plugin terdaftar");
});

test("plugin loader: loadAllPlugins mendaftarkan plugin yang diinject", async () => {
  const manifest = {
    id: "loader-test-plugin",
    name: "Loader Test",
    version: "0.1.0",
    kind: "awcms-mini-plugin",
    appliesTo: ["awcms-mini"],
    permissions: [],
    data: { adapter: "postgres", schema: "loader_test", rls: "required" },
    audit: { required: false, events: [] },
  };
  let migrated = false;
  const pluginModule = {
    migrate: async () => {
      migrated = true;
    },
  };

  // db stub minimal untuk seedPluginPermissions (permissions kosong → tidak menyentuh db)
  const dbStub = {};
  await loadAllPlugins({
    db: dbStub,
    plugins: [{ getManifest: async () => manifest, getModule: async () => pluginModule }],
  });

  assert.ok(getPlugin("loader-test-plugin"), "plugin terdaftar di registry");
  assert.equal(migrated, true, "migrate() plugin dipanggil");
});
