import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// SSR di atas Bun via adapter @astrojs/node (standalone). Ini pengecualian
// Bun-only yang tersanksi (ADR-0002; doc 10 §Standar platform backend;
// doc 18 §Runtime & tooling) karena Astro belum punya adapter Bun
// first-party. Entry hasil build dijalankan `bun ./dist/server/entry.mjs`
// — runtime tetap Bun, hanya paket adapter yang bernama "node".
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  site: "http://localhost:4321"
});
