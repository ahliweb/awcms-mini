import test from "node:test";
import assert from "node:assert/strict";

import { validatePluginManifest, assertValidPluginManifest, isValidPluginManifest } from "../../src/plugins/manifest.mjs";

const VALID_SIKESRA_MANIFEST = {
  id: "sikesra",
  name: "SIKESRA — Sistem Kesehatan Rakyat",
  version: "0.1.0",
  kind: "awcms-mini-plugin",
  appliesTo: ["awcms-mini"],
  permissions: [
    "awcms:sikesra:subject:read",
    "awcms:sikesra:subject:create",
    "awcms:sikesra:record:read",
    "awcms:sikesra:record:create",
    "awcms:sikesra:document:download",
  ],
  data: { adapter: "postgres", schema: "sikesra", rls: "required" },
  audit: { required: true, events: ["subject.create", "record.create", "document.download"] },
  admin: { menuGroup: "Kesehatan", menuOrder: 10, pages: [] },
};

test("plugin manifest: manifest SIKESRA valid lulus tanpa error", () => {
  const errors = validatePluginManifest(VALID_SIKESRA_MANIFEST);
  assert.deepEqual(errors, []);
});

test("plugin manifest: isValidPluginManifest mengembalikan true untuk manifest valid", () => {
  assert.equal(isValidPluginManifest(VALID_SIKESRA_MANIFEST), true);
});

test("plugin manifest: manifest kosong menghasilkan array error", () => {
  const errors = validatePluginManifest({});
  assert.ok(errors.length >= 6, `Diharapkan ≥6 error, dapat ${errors.length}`);
  const fields = errors.map((e) => e.field);
  assert.ok(fields.includes("id"), "Harus ada error untuk id");
  assert.ok(fields.includes("name"), "Harus ada error untuk name");
  assert.ok(fields.includes("version"), "Harus ada error untuk version");
  assert.ok(fields.includes("kind"), "Harus ada error untuk kind");
  assert.ok(fields.includes("appliesTo"), "Harus ada error untuk appliesTo");
  assert.ok(fields.includes("data"), "Harus ada error untuk data");
});

test("plugin manifest: bukan object mengembalikan error manifest", () => {
  const errors = validatePluginManifest(null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "manifest");
});

test("plugin manifest: id dengan spasi atau huruf besar tidak valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, id: "Sikesra Plugin" });
  assert.ok(errors.some((e) => e.field === "id"), "Harus ada error untuk id");
});

test("plugin manifest: kind bukan awcms-mini-plugin tidak valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, kind: "emdash-plugin" });
  assert.ok(errors.some((e) => e.field === "kind"), "Harus ada error untuk kind");
});

test("plugin manifest: data.adapter bukan postgres tidak valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, data: { adapter: "d1", schema: "sikesra", rls: "required" } });
  assert.ok(errors.some((e) => e.field === "data.adapter"), "Harus ada error untuk data.adapter");
});

test("plugin manifest: data.rls bukan required tidak valid (ADR-015)", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, data: { adapter: "postgres", schema: "sikesra", rls: "optional" } });
  assert.ok(errors.some((e) => e.field === "data.rls"), "Harus ada error untuk data.rls");
});

test("plugin manifest: data.schema dengan huruf besar tidak valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, data: { adapter: "postgres", schema: "Sikesra", rls: "required" } });
  assert.ok(errors.some((e) => e.field === "data.schema"), "Harus ada error untuk data.schema");
});

test("plugin manifest: permission dengan format salah tidak valid", () => {
  const errors = validatePluginManifest({
    ...VALID_SIKESRA_MANIFEST,
    permissions: ["sikesra:subject:read", "awcms:sikesra:subject:create"],
  });
  assert.ok(errors.some((e) => e.field === "permissions[0]"), "Harus ada error untuk permissions[0]");
  assert.ok(!errors.some((e) => e.field === "permissions[1]"), "permissions[1] harus valid");
});

test("plugin manifest: audit.required=true dengan events kosong tidak valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, audit: { required: true, events: [] } });
  assert.ok(errors.some((e) => e.field === "audit.events"), "Harus ada error untuk audit.events");
});

test("plugin manifest: audit.required=false dengan events kosong valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, audit: { required: false, events: [] } });
  assert.ok(!errors.some((e) => e.field === "audit.events"), "Tidak boleh ada error untuk audit.events bila required=false");
});

test("plugin manifest: assertValidPluginManifest melempar Error untuk manifest tidak valid", () => {
  assert.throws(
    () => assertValidPluginManifest({}),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Manifest plugin tidak valid"), `Pesan error tidak sesuai: ${err.message}`);
      return true;
    },
  );
});

test("plugin manifest: assertValidPluginManifest mengembalikan manifest yang valid (passthrough)", () => {
  const result = assertValidPluginManifest(VALID_SIKESRA_MANIFEST);
  assert.strictEqual(result, VALID_SIKESRA_MANIFEST);
});

test("plugin manifest: appliesTo tanpa awcms-mini tidak valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, appliesTo: ["awcms"] });
  assert.ok(errors.some((e) => e.field === "appliesTo"), "Harus ada error untuk appliesTo");
});

test("plugin manifest: version bukan semver tidak valid", () => {
  const errors = validatePluginManifest({ ...VALID_SIKESRA_MANIFEST, version: "1.0" });
  assert.ok(errors.some((e) => e.field === "version"), "Harus ada error untuk version");
});
