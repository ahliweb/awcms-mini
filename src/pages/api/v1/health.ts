import type { APIRoute } from "astro";
import { ok } from "../../../modules/_shared/api-response";
import { traceIdsFromRequest } from "../../../modules/_shared/tenant-context";

export const GET: APIRoute = async ({ request }) => {
  const { requestId, correlationId } = traceIdsFromRequest(request);
  return ok(
    {
      status: "ok",
      service: "awcms-mini",
      timestamp: new Date().toISOString()
    },
    { requestId, correlationId }
  );
};
