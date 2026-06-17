import test from "node:test";
import assert from "node:assert/strict";

import { validatePluginManifest } from "../../src/plugins/manifest.mjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../../src/plugins/sikesra/manifest.json"), "utf8"));

test("sikesra: manifest.json lulus validatePluginManifest tanpa error", () => {
  const errors = validatePluginManifest(manifest);
  assert.deepEqual(errors, [], `Manifest SIKESRA tidak valid:\n${JSON.stringify(errors, null, 2)}`);
});

test("sikesra: manifest id = sikesra", () => {
  assert.equal(manifest.id, "sikesra");
});

test("sikesra: manifest kind = awcms-mini-plugin", () => {
  assert.equal(manifest.kind, "awcms-mini-plugin");
});

test("sikesra: manifest data.adapter = postgres", () => {
  assert.equal(manifest.data.adapter, "postgres");
});

test("sikesra: manifest data.rls = required (ADR-015)", () => {
  assert.equal(manifest.data.rls, "required");
});

test("sikesra: manifest data.schema = sikesra (snake_case)", () => {
  assert.equal(manifest.data.schema, "sikesra");
});

test("sikesra: manifest audit.required = true dengan events tidak kosong", () => {
  assert.equal(manifest.audit.required, true);
  assert.ok(Array.isArray(manifest.audit.events) && manifest.audit.events.length > 0, "audit.events harus non-kosong");
});

test("sikesra: manifest permissions semua mengikuti namespace awcms:{module}:{resource}:{action}", () => {
  const PERM_RE = /^awcms:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$/;
  for (const p of manifest.permissions) {
    assert.ok(PERM_RE.test(p), `Permission "${p}" tidak sesuai namespace`);
    assert.ok(p.startsWith("awcms:sikesra:"), `Permission "${p}" harus dimulai dengan awcms:sikesra:`);
  }
});
