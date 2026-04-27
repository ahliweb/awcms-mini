/**
 * Auth sub-router — /api/v1/auth
 *
 * Placeholder stubs for auth endpoints. Full implementation in #251.
 * Endpoints declared here so the route tree is complete and testable.
 */

import { Hono } from "hono";

/**
 * @param {object} [options]
 * @returns {Hono}
 */
export function routeApiV1Auth(options = {}) {
  const app = new Hono();

  // POST /api/v1/auth/login
  app.post("/login", (c) => {
    return c.json({ error: { code: "NOT_IMPLEMENTED", message: "Not yet implemented." } }, 501);
  });

  // POST /api/v1/auth/logout
  app.post("/logout", (c) => {
    return c.json({ error: { code: "NOT_IMPLEMENTED", message: "Not yet implemented." } }, 501);
  });

  // GET /api/v1/auth/me
  app.get("/me", (c) => {
    return c.json({ error: { code: "NOT_IMPLEMENTED", message: "Not yet implemented." } }, 501);
  });

  return app;
}
