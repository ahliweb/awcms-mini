import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validatePluginManifest } from "../../src/plugins/manifest.mjs";

// FF7 sebagai test: SEMUA manifest plugin di src/plugins/*/manifest.json harus valid (ADR-018).
const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(__dirname, "../../src/plugins");

function findManifests() {
  const found = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(pluginsDir, entry.name, "manifest.json");
    if (existsSync(p)) found.push({ id: entry.name, path: p });
  }
  return found;
}

test("FF7: setidaknya ada satu manifest plugin", () => {
  assert.ok(findManifests().length >= 1, "Harus ada minimal satu plugin dengan manifest.json");
});

test("FF7: semua manifest plugin valid terhadap kontrak (ADR-018)", () => {
  const failures = [];
  for (const { id, path } of findManifests()) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      failures.push(`${id}: JSON invalid — ${err.message}`);
      continue;
    }
    const errors = validatePluginManifest(manifest);
    if (errors.length > 0) {
      failures.push(`${id}: ${errors.map((e) => `${e.field}/${e.message}`).join("; ")}`);
    }
  }
  assert.deepEqual(failures, [], `Manifest plugin tidak valid:\n${failures.join("\n")}`);
});
