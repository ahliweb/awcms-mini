/**
 * AWCMS Mini — Hono application factory
 *
 * Creates and configures the Hono application with all middleware and routes.
 * This module is separated from the server entry point so it can be tested
 * independently without binding to a specific port or adapter.
 */

import { Hono } from "hono";

import { middlewareRequestId } from "./middleware/request-id.mjs";
import { middlewareSecurityHeaders } from "./middleware/security-headers.mjs";
import { middlewareTrustedProxy } from "./middleware/trusted-proxy.mjs";
import { middlewareLogger } from "./middleware/logger.mjs";
import { middlewareErrorHandler } from "./middleware/error-handler.mjs";
import { middlewareCors } from "./middleware/cors.mjs";
import { middlewareOptionalAuth } from "./middleware/auth.mjs";
import { routeHealth } from "./routes/health.mjs";
import { routeApiV1 } from "./routes/api-v1.mjs";

/**
 * @param {import('./types.mjs').AppOptions} [options]
 * @returns {Hono}
 */
export function createApp(options = {}) {
  const app = new Hono();

  // Core middleware — order matters
  app.use("*", middlewareRequestId());
  app.use("*", middlewareTrustedProxy(options));
  app.use("*", middlewareLogger(options));
  app.use("*", middlewareSecurityHeaders());
  app.use("*", middlewareCors(options));
  app.use("/api/v1/*", middlewareOptionalAuth(options));

  // Error handler (registered last but catches all thrown errors)
  app.onError(middlewareErrorHandler(options));

  // Routes
  app.route("/health", routeHealth(options));
  app.route("/api/v1", routeApiV1(options));

  // 404 handler
  app.notFound((c) => {
    return c.json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });

  return app;
}
