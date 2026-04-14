import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { postgres } from "emdash/db";
import { getRuntimeConfig } from "./src/config/runtime.mjs";

const runtimeConfig = getRuntimeConfig();

export default defineConfig({
  output: "server",
  adapter: node({
    mode: "standalone",
  }),
  server: {
    host: true,
  },
  integrations: [
    react(),
    emdash({
      database: postgres({
        connectionString: runtimeConfig.databaseUrl,
      }),
    }),
  ],
  devToolbar: { enabled: false },
});
