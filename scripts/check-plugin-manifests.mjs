#!/usr/bin/env node
// Fitness Function FF7: Validasi semua manifest plugin saat build (ADR-018).
// Jalankan: node scripts/check-plugin-manifests.mjs
// Keluar kode 1 (fail) jika ada manifest plugin yang tidak valid.
//
// Menutup gap: manifest sebelumnya hanya tervalidasi bila plugin di-load runtime.
// FF7 memvalidasinya secara statis di pipeline `check`.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validatePluginManifest } from "../src/plugins/manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(__dirname, "../src/plugins");

function findManifests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, "manifest.json");
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      found.push(manifestPath);
    }
  }
  return found;
}

function main() {
  const manifests = findManifests(pluginsDir);

  console.log("FF7 — Plugin Manifest Validation (ADR-018)");
  console.log("=".repeat(50));

  if (manifests.length === 0) {
    console.log("  (tidak ada manifest.json plugin ditemukan)");
  }

  let hasFailed = false;

  for (const path of manifests) {
    const rel = path.replace(join(__dirname, ".."), ".");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`  FAIL  ${rel} — JSON tidak valid: ${err.message}`);
      hasFailed = true;
      continue;
    }

    const errors = validatePluginManifest(manifest);
    if (errors.length > 0) {
      hasFailed = true;
      console.error(`  FAIL  ${rel}`);
      for (const e of errors) {
        console.error(`          ${e.field}: ${e.message}`);
      }
    } else {
      console.log(`  OK    ${rel} (${manifest.id})`);
    }
  }

  console.log("=".repeat(50));

  if (hasFailed) {
    console.error("\nFF7 FAIL: Ada manifest plugin yang tidak valid (lihat di atas).");
    process.exit(1);
  }

  console.log(`\nFF7 PASS: ${manifests.length} manifest plugin valid.`);
  process.exit(0);
}

main();
