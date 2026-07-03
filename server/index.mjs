/**
 * AWCMS Mini — Hono server entry point
 *
 * Starts the Hono application on Bun's native HTTP server (`Bun.serve`).
 * Bun is the primary server runtime (ADR-019 / #361); no Node HTTP adapter needed.
 * Run via: bun run start:api  (or `bun run dev:api` for watch mode).
 */

import { loadLocalEnvFiles } from "../scripts/_local-env.mjs";
import { getRuntimeConfig } from "../src/config/runtime.mjs";
import { loadAllPlugins } from "../src/plugins/loader.mjs";
import { createApp } from "./app.mjs";

if (process.env.NODE_ENV !== "production") {
  loadLocalEnvFiles();
}

const runtimeConfig = getRuntimeConfig();
const port = Number(process.env.PORT) || 3000;
const app = createApp({ runtimeConfig });

// Muat plugin aktif (register + seed permission + jalankan migration schema plugin)
// sebelum melayani request. Idempoten (IF NOT EXISTS + onConflict doNothing).
// Set PLUGINS_AUTOLOAD=false bila migrasi plugin dijalankan sebagai langkah terpisah.
if (process.env.PLUGINS_AUTOLOAD !== "false") {
  try {
    await loadAllPlugins();
    console.log("[server] plugins loaded (registry + permissions + schema migrations)");
  } catch (error) {
    console.error("[server] FATAL: gagal memuat plugin:", error);
    process.exit(1);
  }
}

if (typeof Bun === "undefined") {
  console.error("[server] FATAL: server/index.mjs requires the Bun runtime. Run via `bun run start:api`.");
  process.exit(1);
}

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[server] AWCMS Mini API listening on port ${server.port}`);
console.log(`[server] NODE_ENV=${process.env.NODE_ENV ?? "development"}`);
console.log(`[server] DATABASE_TRANSPORT=${runtimeConfig.databaseTransport}`);
console.log(`[server] SITE_URL=${runtimeConfig.siteUrl ?? "(unset)"}`);
