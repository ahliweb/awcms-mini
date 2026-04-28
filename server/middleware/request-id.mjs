/**
 * Request ID middleware — injects a unique request ID into every request.
 * Reads `X-Request-Id` from the incoming request if present, otherwise
 * generates a new UUID. The ID is available via `c.get('requestId')`.
 */

import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";

export function middlewareRequestId() {
  return createMiddleware(async (c, next) => {
    const existing = c.req.header("x-request-id");
    const id = existing && existing.trim().length > 0 ? existing.trim() : randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  });
}
