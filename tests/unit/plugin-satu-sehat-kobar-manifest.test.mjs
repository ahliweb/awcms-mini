import test from "node:test";
import assert from "node:assert/strict";

import { validatePluginManifest } from "../../src/plugins/manifest.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(__dirname, "../../src/plugins/satu-sehat-kobar/manifest.json"), "utf8"),
);

test("satu-sehat-kobar: manifest.json lulus validatePluginManifest tanpa error", () => {
  const errors = validatePluginManifest(manifest);
  assert.deepEqual(errors, [], `Manifest SatuSehat Kobar tidak valid:\n${JSON.stringify(errors, null, 2)}`);
});

test("satu-sehat-kobar: manifest id = satu-sehat-kobar", () => {
  assert.equal(manifest.id, "satu-sehat-kobar");
});

test("satu-sehat-kobar: manifest kind = awcms-mini-plugin", () => {
  assert.equal(manifest.kind, "awcms-mini-plugin");
});

test("satu-sehat-kobar: manifest data.adapter = postgres", () => {
  assert.equal(manifest.data.adapter, "postgres");
});

test("satu-sehat-kobar: manifest data.rls = required (ADR-015)", () => {
  assert.equal(manifest.data.rls, "required");
});

test("satu-sehat-kobar: manifest data.schema = satu_sehat_kobar (snake_case)", () => {
  assert.equal(manifest.data.schema, "satu_sehat_kobar");
});

test("satu-sehat-kobar: manifest audit.required = true dengan events tidak kosong", () => {
  assert.equal(manifest.audit.required, true);
  assert.ok(Array.isArray(manifest.audit.events) && manifest.audit.events.length > 0);
});

test("satu-sehat-kobar: manifest permissions semua mengikuti namespace awcms:satu_sehat_kobar:*", () => {
  const PERM_RE = /^awcms:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$/;
  for (const p of manifest.permissions) {
    assert.ok(PERM_RE.test(p), `Permission "${p}" tidak sesuai namespace`);
    assert.ok(p.startsWith("awcms:satu_sehat_kobar:"), `Permission "${p}" harus dimulai awcms:satu_sehat_kobar:`);
  }
});
