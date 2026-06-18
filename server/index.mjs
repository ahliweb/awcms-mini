/**
 * AWCMS Mini — Hono server entry point
 *
 * Starts the Hono application using the @hono/node-server adapter.
 * Run with: node server/index.mjs
 * Or via: bun run start:api (defined in package.json)
 */

import { serve } from "@hono/node-server";

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

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`[server] AWCMS Mini API listening on port ${info.port}`);
    console.log(`[server] NODE_ENV=${process.env.NODE_ENV ?? "development"}`);
    console.log(`[server] DATABASE_TRANSPORT=${runtimeConfig.databaseTransport}`);
    console.log(`[server] SITE_URL=${runtimeConfig.siteUrl ?? "(unset)"}`);
  },
);
