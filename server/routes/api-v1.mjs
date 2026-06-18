/**
 * API v1 router — /api/v1
 *
 * Mounts all versioned API sub-routes. Add new feature modules here.
 * Each sub-route module exports a factory function returning a Hono instance.
 */

import { Hono } from "hono";

import { routeApiV1Auth } from "./api-v1-auth.mjs";
import { routeApiV1Files } from "./api-v1-files.mjs";
import { routeApiV1MessageTemplates } from "./api-v1-message-templates.mjs";
import { routeApiV1Notifications } from "./api-v1-notifications.mjs";
import { routeApiV1Permissions } from "./api-v1-permissions.mjs";
import { routeApiV1Roles } from "./api-v1-roles.mjs";
import { routeApiV1Search } from "./api-v1-search.mjs";
import { routeApiV1Security } from "./api-v1-security.mjs";
import { routeApiV1Webhooks } from "./api-v1-webhooks.mjs";

/**
 * @param {object} [options]
 * @returns {Hono}
 */
export function routeApiV1(options = {}) {
  const app = new Hono();

  // Sub-routers
  app.route("/auth", routeApiV1Auth(options));
  app.route("/files", routeApiV1Files(options));
  app.route("/message-templates", routeApiV1MessageTemplates(options));
  app.route("/notifications", routeApiV1Notifications(options));
  app.route("/permissions", routeApiV1Permissions(options));
  app.route("/roles", routeApiV1Roles(options));
  app.route("/search", routeApiV1Search(options));
  app.route("/security", routeApiV1Security(options));
  app.route("/webhooks", routeApiV1Webhooks(options));

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
