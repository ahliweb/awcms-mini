import test from "node:test";
import assert from "node:assert/strict";

import { registerPlugin, getPlugin, listPlugins, clearRegistry } from "../../src/plugins/registry.mjs";

const VALID_MANIFEST = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "0.1.0",
  kind: "awcms-mini-plugin",
  appliesTo: ["awcms-mini"],
  permissions: ["awcms:test_plugin:record:read"],
  data: { adapter: "postgres", schema: "test_plugin", rls: "required" },
  audit: { required: false, events: [] },
};

const VALID_MANIFEST_B = {
  ...VALID_MANIFEST,
  id: "test-plugin-b",
  data: { ...VALID_MANIFEST.data, schema: "test_plugin_b" },
};

// Bersihkan registry setelah setiap test agar tidak ada state yang bocor
test.afterEach(() => {
  clearRegistry();
});

test("plugin registry: registerPlugin dengan manifest valid berhasil", () => {
  registerPlugin(VALID_MANIFEST, {});
  assert.equal(listPlugins().length, 1);
  assert.equal(listPlugins()[0].id, "test-plugin");
});

test("plugin registry: registerPlugin dengan manifest tidak valid melempar Error", () => {
  assert.throws(
    () => registerPlugin({}, {}),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Manifest plugin tidak valid"), `Pesan: ${err.message}`);
      return true;
    },
  );
});

test("plugin registry: registerPlugin dengan plugin ID duplikat melempar Error", () => {
  registerPlugin(VALID_MANIFEST, {});
  assert.throws(
    () => registerPlugin(VALID_MANIFEST, {}),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("sudah terdaftar"), `Pesan: ${err.message}`);
      return true;
    },
  );
});

test("plugin registry: getPlugin mengembalikan entry yang terdaftar", () => {
  const module = { migrate: async () => {} };
  registerPlugin(VALID_MANIFEST, module);

  const entry = getPlugin("test-plugin");
  assert.ok(entry, "Entry harus ada");
  assert.deepEqual(entry.manifest, VALID_MANIFEST);
  assert.strictEqual(entry.module, module);
});

test("plugin registry: getPlugin mengembalikan undefined untuk plugin yang tidak terdaftar", () => {
  const entry = getPlugin("tidak-ada");
  assert.equal(entry, undefined);
});

test("plugin registry: listPlugins mengembalikan array manifest yang terdaftar", () => {
  registerPlugin(VALID_MANIFEST, {});
  registerPlugin(VALID_MANIFEST_B, {});

  const manifests = listPlugins();
  assert.equal(manifests.length, 2);
  const ids = manifests.map((m) => m.id).sort();
  assert.deepEqual(ids, ["test-plugin", "test-plugin-b"]);
});

test("plugin registry: listPlugins mengembalikan array kosong jika tidak ada plugin", () => {
  assert.deepEqual(listPlugins(), []);
});

test("plugin registry: clearRegistry membersihkan semua plugin", () => {
  registerPlugin(VALID_MANIFEST, {});
  assert.equal(listPlugins().length, 1);
  clearRegistry();
  assert.equal(listPlugins().length, 0);
});
