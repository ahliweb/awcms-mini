import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { postgres } from "emdash/db";

const databaseUrl = process.env.DATABASE_URL || "postgres://localhost:5432/awcms_mini_dev";

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
        connectionString: databaseUrl,
      }),
    }),
  ],
  devToolbar: { enabled: false },
});
