import type { APIRoute } from "astro";
import { ok } from "../../../modules/_shared/api-response";
import { listModules } from "../../../modules";

export const prerender = true;

export const GET: APIRoute = async () =>
  ok({
    status: "ok",
    service: "awcms-mini",
    runtime: "bun",
    buildMode: "static-foundation",
    moduleCount: listModules().length,
    generatedAt: new Date().toISOString(),
  });
