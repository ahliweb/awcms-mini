import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runWithContext } from "../../src/cms/context.mjs";
import { definePlugin, PluginRouteError } from "../../src/cms/plugin-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "../../src");

test("cms-seam: context.mjs mengekspor runWithContext", () => {
  assert.equal(typeof runWithContext, "function");
});

test("cms-seam: plugin-runtime.mjs mengekspor definePlugin & PluginRouteError", () => {
  assert.equal(typeof definePlugin, "function");
  assert.ok(PluginRouteError, "PluginRouteError harus terdefinisi");
});

// Guard Fase 2 (ADR-020): tidak boleh ada `import ... from "emdash"` di luar src/cms/.
test("cms-seam: tidak ada import langsung 'from \"emdash\"' di luar src/cms/", () => {
  const offenders = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "cms") continue; // seam dikecualikan
        walk(full);
        continue;
      }
      if (!/\.(mjs|js|ts|tsx)$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf8");
      // hanya cocokkan import dari paket "emdash" persis (bukan "emdash/...")
      if (/from\s+["']emdash["']/.test(text)) offenders.push(full.replace(srcDir, "src"));
    }
  }
  walk(srcDir);
  assert.deepEqual(offenders, [], `Import langsung 'emdash' harus lewat src/cms/ seam. Pelanggar: ${offenders.join(", ")}`);
});
