import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { postgres } from "emdash/db";
import miniAuthIntegration from "./src/integrations/mini-auth.mjs";
import { awcmsUsersAdminPlugin } from "./src/plugins/awcms-users-admin/index.mjs";
import { getRuntimeConfig } from "./src/config/runtime.mjs";

const runtimeConfig = getRuntimeConfig();
const adapter = runtimeConfig.runtimeTarget === "node"
  ? node({ mode: "standalone" })
  : cloudflare({ sessionKVBindingName: "SESSION" });

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
      database: postgres({
        connectionString: runtimeConfig.databaseUrl,
      }),
      plugins: [awcmsUsersAdminPlugin()],
    }),
  ],
  devToolbar: { enabled: false },
});
