import test from "node:test";
import assert from "node:assert/strict";

import { loadAllPlugins } from "../../src/plugins/loader.mjs";
import { listPlugins, clearRegistry } from "../../src/plugins/registry.mjs";

test.afterEach(() => {
  clearRegistry();
});

test("plugin loader: loadAllPlugins dengan ACTIVE_PLUGINS kosong tidak error", async () => {
  // ACTIVE_PLUGINS kosong (belum ada plugin SIKESRA/SatuSehat) — harus selesai tanpa error
  await assert.doesNotReject(
    loadAllPlugins({ db: null }),
    "loadAllPlugins dengan ACTIVE_PLUGINS kosong harus selesai tanpa error",
  );
});

test("plugin loader: loadAllPlugins dengan ACTIVE_PLUGINS kosong tidak mendaftarkan plugin", async () => {
  await loadAllPlugins({ db: null });
  assert.deepEqual(listPlugins(), [], "Harus tidak ada plugin terdaftar");
});
