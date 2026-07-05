import type { APIRoute } from "astro";
import { ok } from "../../../modules/_shared/api-response";
import { listModules } from "../../../modules";

// SSR dinamis (bukan prerender) — endpoint ini harus berjalan per-request
// di atas server (@astrojs/node), bukan file statis hasil build. Lihat
// astro.config.mjs dan ADR-0002.
export const GET: APIRoute = async () =>
  ok({
    status: "ok",
    service: "awcms-mini",
    runtime: "bun",
    buildMode: "server",
    moduleCount: listModules().length,
    generatedAt: new Date().toISOString()
  });
