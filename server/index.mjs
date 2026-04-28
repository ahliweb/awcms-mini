/**
 * AWCMS Mini — Hono server entry point
 *
 * Starts the Hono application using the @hono/node-server adapter.
 * Run with: node server/index.mjs
 * Or via: pnpm start (defined in package.json)
 */

import { serve } from "@hono/node-server";

import { loadLocalEnvFiles } from "../scripts/_local-env.mjs";
import { getRuntimeConfig } from "../src/config/runtime.mjs";
import { createApp } from "./app.mjs";

loadLocalEnvFiles();

const runtimeConfig = getRuntimeConfig();
const port = Number(process.env.PORT) || 3000;
const app = createApp({ runtimeConfig });

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
