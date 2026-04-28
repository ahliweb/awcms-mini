import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { fileURLToPath } from "node:url";
import miniAuthIntegration from "./src/integrations/mini-auth.mjs";
import { createSikesraAdminPluginDescriptor } from "../awcms-mini-sikesra/src/plugins/sikesra-admin/index.mjs";
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

const sikesraPluginDescriptor = createSikesraAdminPluginDescriptor({
  entrypoint: fileURLToPath(new URL("../awcms-mini-sikesra/src/plugins/sikesra-admin/index.mjs", import.meta.url)),
  adminEntry: fileURLToPath(new URL("../awcms-mini-sikesra/src/plugins/sikesra-admin/admin.tsx", import.meta.url)),
  adminPages: [{ path: "/about-sikesra", label: "About SIKESRA", icon: "info" }],
});

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
      plugins: [sikesraPluginDescriptor],
    }),
  ],
  devToolbar: { enabled: false },
});
