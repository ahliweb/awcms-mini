/**
 * Structured request logger middleware.
 * Logs method, path, status, duration, and request ID for every request.
 * Writes to stdout as JSON in production, pretty-printed in development.
 */

import { createMiddleware } from "hono/factory";

const isDev = process.env.NODE_ENV !== "production";

function log(entry) {
  if (isDev) {
    const { method, path, status, durationMs, requestId } = entry;
    console.log(`[${requestId ?? "-"}] ${method} ${path} → ${status} (${durationMs}ms)`);
  } else {
    console.log(JSON.stringify(entry));
  }
}

/**
 * @param {object} [_options]
 */
export function middlewareLogger(_options = {}) {
  return createMiddleware(async (c, next) => {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;

    log({
      ts: new Date().toISOString(),
      requestId: c.get("requestId") ?? null,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs,
    });
  });
}
