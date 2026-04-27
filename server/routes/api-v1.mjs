/**
 * API v1 router — /api/v1
 *
 * Mounts all versioned API sub-routes. Add new feature modules here.
 * Each sub-route module exports a factory function returning a Hono instance.
 */

import { Hono } from "hono";

import { routeApiV1Auth } from "./api-v1-auth.mjs";
import { routeApiV1Permissions } from "./api-v1-permissions.mjs";
import { routeApiV1Roles } from "./api-v1-roles.mjs";

/**
 * @param {object} [options]
 * @returns {Hono}
 */
export function routeApiV1(options = {}) {
  const app = new Hono();

  // Sub-routers
  app.route("/auth", routeApiV1Auth(options));
  app.route("/permissions", routeApiV1Permissions(options));
  app.route("/roles", routeApiV1Roles(options));

  // Version metadata
  app.get("/", (c) => {
    return c.json({
      version: "v1",
      service: "awcms-mini",
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
