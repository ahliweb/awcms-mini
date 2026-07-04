import type { APIRoute } from "astro";
import { ok } from "../../../modules/_shared/api-response";

export const GET: APIRoute = async () =>
  ok({
    status: "ok",
    service: "awcms-mini",
    timestamp: new Date().toISOString(),
  });
