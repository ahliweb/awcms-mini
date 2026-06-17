/**
 * Structured request logger middleware (Pino, ADR-021).
 * Mencatat method, path, status, durasi, dan requestId untuk setiap request
 * sebagai JSON terstruktur via Pino, dengan redaction field sensitif.
 *
 * Child logger ber-`requestId` dipasang di `c.set("logger", ...)` agar
 * handler/route dapat memakai logger yang sudah terkorelasi.
 */

import { createMiddleware } from "hono/factory";

import { rootLogger } from "../../src/observability/logger.mjs";

/**
 * @param {object} [options]
 * @param {import("pino").Logger} [options.logger] - Override logger (untuk test).
 */
export function middlewareLogger(options = {}) {
  const baseLogger = options.logger ?? rootLogger;

  return createMiddleware(async (c, next) => {
    const requestId = c.get("requestId") ?? null;
    const log = requestId ? baseLogger.child({ requestId }) : baseLogger;

    // Sediakan child logger ke handler berikutnya.
    c.set("logger", log);

    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;

    log.info(
      {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs,
      },
      "request.completed",
    );
  });
}
