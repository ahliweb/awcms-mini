import type { APIRoute } from "astro";
import { ok, fail, toErrorResponse } from "../../../../../modules/_shared/api-response";
import { traceIdsFromRequest } from "../../../../../modules/_shared/tenant-context";
import { checkPoolHealth } from "../../../../../lib/database/pool-health";

export const GET: APIRoute = async ({ request }) => {
  const { requestId, correlationId } = traceIdsFromRequest(request);
  try {
    const health = await checkPoolHealth();
    if (health.status === "down") {
      return fail(503, "DATABASE_BUSY", "Database tidak dapat dijangkau.", { correlationId });
    }
    return ok(health, { requestId, correlationId });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
};
