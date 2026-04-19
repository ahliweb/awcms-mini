import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { fileURLToPath } from "node:url";
import miniAuthIntegration from "./src/integrations/mini-auth.mjs";
import { awcmsUsersAdminPlugin } from "./src/plugins/awcms-users-admin/index.mjs";
import { getRuntimeConfig } from "./src/config/runtime.mjs";

const runtimeConfig = getRuntimeConfig();
const adapter = runtimeConfig.runtimeTarget === "node"
  ? node({ mode: "standalone" })
  : cloudflare({ sessionKVBindingName: "SESSION" });

const emdashDatabase = {
  entrypoint: fileURLToPath(new URL("./src/emdash/postgres-runtime.mjs", import.meta.url)),
  config: {
    pool: {
      min: 0,
      max: 10,
    },
  },
  type: "postgres",
};

export default defineConfig({
  output: "server",
  ...(runtimeConfig.siteUrl ? { site: runtimeConfig.siteUrl } : {}),
  adapter,
  server: {
    host: true,
  },
  integrations: [
    react(),
    miniAuthIntegration(),
    emdash({
      database: emdashDatabase,
      plugins: [awcmsUsersAdminPlugin()],
    }),
  ],
  devToolbar: { enabled: false },
});
