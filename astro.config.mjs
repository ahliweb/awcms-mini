// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// AWCMS-Mini — modular monolith (Bun + Astro + PostgreSQL).
// Semua API berada di src/pages/api/v1 (route tipis → module handler).
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: {
    port: 4321,
    host: true
  },
  security: {
    checkOrigin: true
  }
});
